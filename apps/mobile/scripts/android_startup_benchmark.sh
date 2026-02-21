#!/usr/bin/env bash
set -euo pipefail

ADB_BIN="${ADB_BIN:-adb}"
PACKAGE="${PACKAGE:-tech.dongdongbh.mindwtr}"
ACTIVITY="${ACTIVITY:-.MainActivity}"
MODE="${MODE:-cold}"
RUNS="${RUNS:-10}"
WAIT_MS="${WAIT_MS:-3500}"
REQUIRED_JS_MARKER="${REQUIRED_JS_MARKER:-js.splash_hidden}"
LOGCAT_SPECS="${LOGCAT_SPECS:-MindwtrStartup:I ReactNativeJS:I LOG_FLOWCTRL:W AndroidRuntime:E Expo:E System.err:W *:S}"
LOGCAT_USE_PID="${LOGCAT_USE_PID:-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${OUT_DIR:-${MOBILE_DIR}/build/startup-benchmark}"

usage() {
  cat <<'EOF'
Run repeatable Android startup measurements (am start -W + startup markers).

Examples:
  bash apps/mobile/scripts/android_startup_benchmark.sh
  MODE=warm RUNS=15 WAIT_MS=5000 bash apps/mobile/scripts/android_startup_benchmark.sh
  PACKAGE=tech.dongdongbh.mindwtr ACTIVITY=.MainActivity bash apps/mobile/scripts/android_startup_benchmark.sh

Environment variables:
  ADB_BIN   adb binary path (default: adb)
  PACKAGE   Android package name
  ACTIVITY  Activity name, e.g. .MainActivity or tech.example/.MainActivity
  MODE      cold | warm (default: cold)
  RUNS      Number of measured launches (default: 10)
  WAIT_MS   Post-launch wait for marker logs (default: 3500)
  REQUIRED_JS_MARKER
           Required JS phase marker for a run to be considered fully started
           (default: js.splash_hidden, set empty to disable)
  LOGCAT_SPECS
           Space-separated logcat filter specs used when capturing each run.
           Default includes startup markers and runtime errors.
  LOGCAT_USE_PID
           Use --pid filtering for logcat capture when possible (default: 1).
  OUT_DIR   Output directory for raw logs and CSV summaries
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$MODE" != "cold" && "$MODE" != "warm" ]]; then
  echo "MODE must be 'cold' or 'warm', got: $MODE" >&2
  exit 1
fi

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || (( RUNS < 1 )); then
  echo "RUNS must be a positive integer, got: $RUNS" >&2
  exit 1
fi

if ! [[ "$WAIT_MS" =~ ^[0-9]+$ ]]; then
  echo "WAIT_MS must be a non-negative integer, got: $WAIT_MS" >&2
  exit 1
fi

if [[ "$ACTIVITY" == */* ]]; then
  COMPONENT="$ACTIVITY"
else
  COMPONENT="${PACKAGE}/${ACTIVITY}"
fi

if ! command -v "$ADB_BIN" >/dev/null 2>&1; then
  echo "adb binary not found: $ADB_BIN" >&2
  exit 1
fi

if ! "$ADB_BIN" get-state >/dev/null 2>&1; then
  echo "No connected Android device/emulator. Start one and verify 'adb devices'." >&2
  exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
run_dir="${OUT_DIR}/${timestamp}-${MODE}"
mkdir -p "$run_dir"

results_csv="${run_dir}/am_start_results.csv"
phases_tsv="${run_dir}/phase_durations.tsv"
js_since_start_tsv="${run_dir}/js_since_start.tsv"
summary_txt="${run_dir}/summary.txt"

printf "run,mode,this_time_ms,total_time_ms,wait_time_ms,status,launch_state,sample_quality\n" > "$results_csv"
printf "run\tphase\tduration_ms\n" > "$phases_tsv"
printf "run\tphase\tsince_js_start_ms\n" > "$js_since_start_tsv"

sleep_seconds="$(awk "BEGIN { printf \"%.3f\", ${WAIT_MS}/1000 }")"
read -r -a logcat_specs <<< "$LOGCAT_SPECS"

collect_metric() {
  local key="$1"
  local output="$2"
  printf "%s\n" "$output" \
    | awk -F': ' -v metric="$key" '$1 ~ metric { gsub(/\r/, "", $2); print $2; exit }'
}

append_phase_durations() {
  local run="$1"
  local logfile="$2"
  awk -v run="$run" '
    {
      if (match($0, /phase=([^ ]+)/, p) && match($0, /durationMs=([0-9]+)/, d)) {
        printf "%s\t%s\t%s\n", run, p[1], d[1]
      }
    }
  ' "$logfile" >> "$phases_tsv"
}

append_js_since_start() {
  local run="$1"
  local logfile="$2"
  awk -v run="$run" '
    {
      if (match($0, /phase=([^ ]+)/, p) && match($0, /sinceJsStartMs=([0-9]+)/, s)) {
        printf "%s\t%s\t%s\n", run, p[1], s[1]
      }
    }
  ' "$logfile" >> "$js_since_start_tsv"
}

log_has_phase_marker() {
  local logfile="$1"
  local phase="$2"
  [[ -z "$phase" ]] && return 0
  if command -v rg >/dev/null 2>&1; then
    rg -q "phase=${phase}( |$)" "$logfile"
    return $?
  fi
  grep -q "phase=${phase}" "$logfile"
}

format_metric() {
  local value="$1"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf "%sms" "$value"
    return
  fi
  printf "na"
}

print_metric_summary() {
  local label="$1"
  shift
  local values=("$@")
  local tmp
  tmp="$(mktemp)"
  {
    for value in "${values[@]}"; do
      if [[ "$value" =~ ^[0-9]+$ ]]; then
        printf "%s\n" "$value"
      fi
    done
  } | sort -n > "$tmp"

  local count
  count="$(wc -l < "$tmp" | tr -d ' ')"
  if [[ "$count" == "0" ]]; then
    printf "%s: no samples\n" "$label" | tee -a "$summary_txt"
    rm -f "$tmp"
    return
  fi

  local min max median p95 mean median_index p95_index
  min="$(sed -n '1p' "$tmp")"
  max="$(sed -n "${count}p" "$tmp")"
  median_index=$(( (count + 1) / 2 ))
  p95_index=$(( (95 * count + 99) / 100 ))
  if (( p95_index < 1 )); then p95_index=1; fi
  if (( p95_index > count )); then p95_index=count; fi
  median="$(sed -n "${median_index}p" "$tmp")"
  p95="$(sed -n "${p95_index}p" "$tmp")"
  mean="$(awk '{ total += $1 } END { if (NR > 0) printf "%.1f", total / NR; else print "0.0" }' "$tmp")"

  printf "%s: n=%s min=%sms median=%sms p95=%sms mean=%sms max=%sms\n" \
    "$label" "$count" "$min" "$median" "$p95" "$mean" "$max" | tee -a "$summary_txt"
  rm -f "$tmp"
}

print_phase_summaries() {
  local phases
  phases="$(awk 'NR > 1 { print $2 }' "$phases_tsv" | sort -u)"
  if [[ -z "$phases" ]]; then
    printf "Startup marker durations: no durationMs markers found in logcat.\n" | tee -a "$summary_txt"
    return
  fi

  printf "Startup marker durations:\n" | tee -a "$summary_txt"
  while IFS= read -r phase; do
    [[ -z "$phase" ]] && continue
    mapfile -t phase_values < <(awk -v target="$phase" 'NR > 1 && $2 == target { print $3 }' "$phases_tsv")
    print_metric_summary "  ${phase}" "${phase_values[@]}"
  done <<< "$phases"
}

print_js_since_start_summaries() {
  local phases
  phases="$(awk 'NR > 1 { print $2 }' "$js_since_start_tsv" | sort -u)"
  if [[ -z "$phases" ]]; then
    printf "JS startup markers: no sinceJsStartMs markers found.\n" | tee -a "$summary_txt"
    return
  fi

  printf "JS startup markers (since JS start):\n" | tee -a "$summary_txt"
  while IFS= read -r phase; do
    [[ -z "$phase" ]] && continue
    mapfile -t phase_values < <(awk -v target="$phase" 'NR > 1 && $2 == target { print $3 }' "$js_since_start_tsv")
    print_metric_summary "  ${phase}" "${phase_values[@]}"
  done <<< "$phases"
}

if [[ "$MODE" == "warm" ]]; then
  echo "Priming app process for warm starts..."
  "$ADB_BIN" shell am force-stop "$PACKAGE" >/dev/null || true
  "$ADB_BIN" shell am start -W -n "$COMPONENT" >/dev/null 2>&1 || true
  "$ADB_BIN" shell input keyevent 3 >/dev/null 2>&1 || true
  sleep 1
fi

declare -a this_times=()
declare -a total_times=()
declare -a wait_times=()
declare -a total_times_quality_ok=()
declare -a wait_times_quality_ok=()
missing_total_time_runs=0
empty_marker_runs=0
missing_required_js_marker_runs=0
crash_detected_runs=0
log_quota_dropped_runs=0

echo "Running ${RUNS} ${MODE} start measurements for ${COMPONENT}"
echo "Logs and reports: ${run_dir}"

for run in $(seq 1 "$RUNS"); do
  run_label="$(printf "%02d" "$run")"
  log_file="${run_dir}/run-${run_label}.log"
  crash_log_file="${run_dir}/run-${run_label}-crash.log"
  am_start_file="${run_dir}/run-${run_label}-am-start.txt"

  "$ADB_BIN" logcat -c >/dev/null 2>&1 || true

  if [[ "$MODE" == "cold" ]]; then
    "$ADB_BIN" shell am force-stop "$PACKAGE" >/dev/null
  fi

  start_output="$("$ADB_BIN" shell am start -W -n "$COMPONENT" 2>&1 || true)"
  printf "%s\n" "$start_output" > "$am_start_file"
  sleep "$sleep_seconds"
  app_pid=""
  if [[ "$LOGCAT_USE_PID" == "1" ]]; then
    app_pid="$("$ADB_BIN" shell pidof -s "$PACKAGE" 2>/dev/null | tr -d '\r' || true)"
  fi

  if [[ "$LOGCAT_USE_PID" == "1" && "$app_pid" =~ ^[0-9]+$ ]]; then
    "$ADB_BIN" logcat -d --pid="$app_pid" -v time "${logcat_specs[@]}" > "$log_file" || true
  else
    "$ADB_BIN" logcat -d -v time "${logcat_specs[@]}" > "$log_file" || true
  fi
  "$ADB_BIN" logcat -b crash -d -v time > "$crash_log_file" || true

  this_time="$(collect_metric "ThisTime" "$start_output")"
  total_time="$(collect_metric "TotalTime" "$start_output")"
  wait_time="$(collect_metric "WaitTime" "$start_output")"
  status="$(collect_metric "Status" "$start_output")"
  launch_state="$(collect_metric "LaunchState" "$start_output")"
  status="${status:-unknown}"
  launch_state="${launch_state:-unknown}"
  sample_quality="ok"
  if [[ -z "${total_time:-}" ]]; then
    missing_total_time_runs=$((missing_total_time_runs + 1))
    sample_quality="missing_total_time"
    if [[ "${wait_time:-}" =~ ^[0-9]+$ ]] && (( wait_time >= 3000 )); then
      sample_quality="missing_total_time_wait_timeout"
    fi
  fi
  if [[ ! -s "$log_file" ]]; then
    empty_marker_runs=$((empty_marker_runs + 1))
    if [[ "$sample_quality" == "ok" ]]; then
      sample_quality="empty_marker_log"
    else
      sample_quality="${sample_quality}+empty_marker_log"
    fi
  fi
  if [[ -n "$REQUIRED_JS_MARKER" ]] && ! log_has_phase_marker "$log_file" "$REQUIRED_JS_MARKER"; then
    missing_required_js_marker_runs=$((missing_required_js_marker_runs + 1))
    if [[ "$sample_quality" == "ok" ]]; then
      sample_quality="missing_required_js_marker"
    else
      sample_quality="${sample_quality}+missing_required_js_marker"
    fi
  fi
  if command -v rg >/dev/null 2>&1; then
    if rg -q "LOGS OVER PROC QUOTA|LOG_FLOWCTRL" "$log_file"; then
      log_quota_dropped_runs=$((log_quota_dropped_runs + 1))
      if [[ "$sample_quality" == "ok" ]]; then
        sample_quality="log_quota_dropped"
      else
        sample_quality="${sample_quality}+log_quota_dropped"
      fi
    fi
  elif grep -Eq "LOGS OVER PROC QUOTA|LOG_FLOWCTRL" "$log_file"; then
    log_quota_dropped_runs=$((log_quota_dropped_runs + 1))
    if [[ "$sample_quality" == "ok" ]]; then
      sample_quality="log_quota_dropped"
    else
      sample_quality="${sample_quality}+log_quota_dropped"
    fi
  fi
  if command -v rg >/dev/null 2>&1; then
    if rg -q "(FATAL EXCEPTION|Fatal signal|Abort message:|>>> ${PACKAGE} <<<|Process: ${PACKAGE})" "$crash_log_file"; then
      crash_detected_runs=$((crash_detected_runs + 1))
      if [[ "$sample_quality" == "ok" ]]; then
        sample_quality="crash_detected"
      else
        sample_quality="${sample_quality}+crash_detected"
      fi
    fi
  elif grep -Eq "(FATAL EXCEPTION|Fatal signal|Abort message:|>>> ${PACKAGE} <<<|Process: ${PACKAGE})" "$crash_log_file"; then
    crash_detected_runs=$((crash_detected_runs + 1))
    if [[ "$sample_quality" == "ok" ]]; then
      sample_quality="crash_detected"
    else
      sample_quality="${sample_quality}+crash_detected"
    fi
  fi

  printf "%s,%s,%s,%s,%s,%s,%s,%s\n" \
    "$run" "$MODE" "${this_time:-}" "${total_time:-}" "${wait_time:-}" "$status" "$launch_state" "$sample_quality" >> "$results_csv"

  if [[ -n "${this_time:-}" ]]; then this_times+=("$this_time"); fi
  if [[ -n "${total_time:-}" ]]; then total_times+=("$total_time"); fi
  if [[ -n "${wait_time:-}" ]]; then wait_times+=("$wait_time"); fi
  if [[ "$sample_quality" == "ok" ]]; then
    if [[ -n "${total_time:-}" ]]; then total_times_quality_ok+=("$total_time"); fi
    if [[ -n "${wait_time:-}" ]]; then wait_times_quality_ok+=("$wait_time"); fi
  fi

  append_phase_durations "$run" "$log_file"
  append_js_since_start "$run" "$log_file"
  printf "run %s/%s: ThisTime=%s TotalTime=%s WaitTime=%s Status=%s LaunchState=%s Quality=%s\n" \
    "$run" "$RUNS" "$(format_metric "${this_time:-}")" "$(format_metric "${total_time:-}")" "$(format_metric "${wait_time:-}")" "$status" "$launch_state" "$sample_quality"
  if [[ "$LOGCAT_USE_PID" == "1" ]]; then
    if [[ "$app_pid" =~ ^[0-9]+$ ]]; then
      printf "  pid=%s logcat=pid_filtered\n" "$app_pid"
    else
      printf "  pid=unknown logcat=global_fallback\n"
    fi
  fi

  if [[ "$MODE" == "warm" ]]; then
    "$ADB_BIN" shell input keyevent 3 >/dev/null 2>&1 || true
    sleep 0.4
  fi
done

{
  printf "Android startup benchmark summary\n"
  printf "package=%s component=%s mode=%s runs=%s wait_ms=%s\n" "$PACKAGE" "$COMPONENT" "$MODE" "$RUNS" "$WAIT_MS"
} > "$summary_txt"

print_metric_summary "ThisTime" "${this_times[@]}"
print_metric_summary "TotalTime" "${total_times[@]}"
print_metric_summary "WaitTime" "${wait_times[@]}"
if [[ -n "$REQUIRED_JS_MARKER" ]]; then
  print_metric_summary "TotalTime (quality=ok)" "${total_times_quality_ok[@]}"
  print_metric_summary "WaitTime (quality=ok)" "${wait_times_quality_ok[@]}"
fi
print_phase_summaries
print_js_since_start_summaries
printf "Sample quality: missing_total_time_runs=%s empty_marker_runs=%s missing_required_js_marker_runs=%s required_js_marker=%s log_quota_dropped_runs=%s\n" \
  "$missing_total_time_runs" "$empty_marker_runs" "$missing_required_js_marker_runs" "${REQUIRED_JS_MARKER:-disabled}" "$log_quota_dropped_runs" | tee -a "$summary_txt"
printf "Crash quality: crash_detected_runs=%s crash_logs=%s\n" \
  "$crash_detected_runs" "${run_dir}/run-*-crash.log" | tee -a "$summary_txt"

cat <<EOF

Done.
Summary:  $summary_txt
Launch CSV: $results_csv
Phase TSV:  $phases_tsv
JS Markers TSV: $js_since_start_tsv
Raw logs:   ${run_dir}/run-*.log
Crash logs: ${run_dir}/run-*-crash.log
EOF
