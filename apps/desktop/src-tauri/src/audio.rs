use crate::*;

#[tauri::command]
pub(crate) fn start_audio_recording(
    state: tauri::State<'_, AudioRecorderState>,
) -> Result<(), String> {
    let mut guard = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Recorder lock poisoned".to_string())?;
    if guard.is_some() {
        return Err("Recording already in progress".into());
    }

    let samples: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
    let info: Arc<Mutex<Option<RecorderInfo>>> = Arc::new(Mutex::new(None));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();

    let samples_clone = samples.clone();
    let info_clone = info.clone();
    let join = std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_input_device().or_else(|| {
            host.input_devices()
                .ok()
                .and_then(|mut devices| devices.next())
        }) {
            Some(device) => device,
            None => {
                let _ = ready_tx.send(Err("No audio input device available".to_string()));
                return;
            }
        };
        let config = match device.default_input_config() {
            Ok(cfg) => cfg,
            Err(err) => {
                let _ = ready_tx.send(Err(format!("Failed to read input config: {err}")));
                return;
            }
        };
        let sample_rate = config.sample_rate().0;
        let channels = config.channels();

        let err_fn = |err| {
            eprintln!("[audio] stream error: {err}");
        };

        let stream_config: cpal::StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    let Ok(mut buffer) = samples_clone.lock() else {
                        return;
                    };
                    buffer.extend(data.iter().map(|sample| {
                        let clamped = sample.clamp(-1.0, 1.0);
                        (clamped * i16::MAX as f32) as i16
                    }));
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let Ok(mut buffer) = samples_clone.lock() else {
                        return;
                    };
                    buffer.extend_from_slice(data);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let Ok(mut buffer) = samples_clone.lock() else {
                        return;
                    };
                    buffer.extend(data.iter().map(|sample| (*sample as i32 - 32768) as i16));
                },
                err_fn,
                None,
            ),
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        };

        let stream = match stream {
            Ok(stream) => stream,
            Err(err) => {
                let _ = ready_tx.send(Err(format!("Failed to create audio stream: {err}")));
                return;
            }
        };

        if let Err(err) = stream.play() {
            let _ = ready_tx.send(Err(format!("Failed to start audio stream: {err}")));
            return;
        }

        if let Ok(mut info_guard) = info_clone.lock() {
            *info_guard = Some(RecorderInfo {
                sample_rate,
                channels,
            });
        }

        let _ = ready_tx.send(Ok(()));

        let _ = stop_rx.recv();
        drop(stream);
    });

    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {
            *guard = Some(AudioRecorderHandle {
                stop_tx,
                samples,
                info,
                join: Some(join),
            });
            Ok(())
        }
        Ok(Err(err)) => Err(err),
        Err(_) => Err("Audio device did not respond".into()),
    }
}

#[tauri::command]
pub(crate) fn stop_audio_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioRecorderState>,
) -> Result<AudioCaptureResult, String> {
    let mut guard = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Recorder lock poisoned".to_string())?;
    let mut recorder = guard
        .take()
        .ok_or_else(|| "No active recording".to_string())?;

    let _ = recorder.stop_tx.send(());
    if let Some(join) = recorder.join.take() {
        let _ = join.join();
    }

    let info = recorder
        .info
        .lock()
        .map_err(|_| "Recorder info lock poisoned".to_string())?;
    let info = info
        .clone()
        .ok_or_else(|| "Recorder did not initialize".to_string())?;
    let samples = recorder
        .samples
        .lock()
        .map_err(|_| "Recorder buffer lock poisoned".to_string())?;
    if samples.is_empty() {
        return Err("No audio captured".into());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let file_name = format!("mindwtr-audio-{timestamp}.wav");
    let relative_path = format!("{}/audio-captures/{}", APP_NAME, file_name);

    let target_dir = get_data_dir(&app).join("audio-captures");
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target_path = target_dir.join(&file_name);

    let spec = hound::WavSpec {
        channels: info.channels,
        sample_rate: info.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&target_path, spec).map_err(|e| e.to_string())?;
    for sample in samples.iter() {
        writer.write_sample(*sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(AudioCaptureResult {
        path: target_path.to_string_lossy().to_string(),
        relative_path,
        sample_rate: info.sample_rate,
        channels: info.channels,
        size: samples.len() * std::mem::size_of::<i16>(),
    })
}

#[tauri::command]
pub(crate) fn transcribe_whisper(
    model_path: String,
    audio_path: String,
    language: Option<String>,
) -> Result<String, String> {
    let model_exists = Path::new(&model_path).exists();
    if !model_exists {
        return Err("Whisper model not found".into());
    }

    let mut reader = hound::WavReader::open(&audio_path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.channels > 2 {
        return Err("Unsupported audio channel count".into());
    }

    let mut samples = Vec::new();
    for sample in reader.samples::<i16>() {
        let value = sample.map_err(|e| e.to_string())?;
        samples.push(value);
    }

    let mut audio = vec![0.0f32; samples.len()];
    whisper_rs::convert_integer_to_float_audio(&samples, &mut audio).map_err(|e| e.to_string())?;
    if spec.channels == 2 {
        let mut mono_audio = vec![0.0f32; audio.len() / 2];
        whisper_rs::convert_stereo_to_mono_audio(&audio, &mut mono_audio)
            .map_err(|e| e.to_string())?;
        audio = mono_audio;
    }
    if spec.sample_rate != 16_000 {
        audio = resample_linear(&audio, spec.sample_rate, 16_000);
    }

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if let Ok(threads) = std::thread::available_parallelism() {
        params.set_n_threads(threads.get() as i32);
    }

    let language_hint = language.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    if let Some(ref lang) = language_hint {
        params.set_language(Some(lang));
    }

    let ctx = WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())
        .map_err(|e| e.to_string())?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    state.full(params, &audio[..]).map_err(|e| e.to_string())?;

    let num_segments = state.full_n_segments();
    let mut text = String::new();
    if num_segments > 0 {
        for i in 0..num_segments {
            if let Some(segment) = state.get_segment(i) {
                if let Ok(seg_text) = segment.to_str_lossy() {
                    text.push_str(&seg_text);
                }
            }
        }
    }

    Ok(text.trim().to_string())
}

fn resample_linear(input: &[f32], input_rate: u32, target_rate: u32) -> Vec<f32> {
    if input_rate == target_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = input_rate as f64 / target_rate as f64;
    let output_len = ((input.len() as f64) / ratio).round().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let position = i as f64 * ratio;
        let index = position.floor() as usize;
        let next_index = (index + 1).min(input.len() - 1);
        let frac = position - index as f64;
        let sample = input[index] * (1.0 - frac as f32) + input[next_index] * (frac as f32);
        output.push(sample);
    }
    output
}
