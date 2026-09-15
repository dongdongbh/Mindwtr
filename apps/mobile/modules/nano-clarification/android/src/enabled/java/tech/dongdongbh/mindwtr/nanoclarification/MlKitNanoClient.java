package tech.dongdongbh.mindwtr.nanoclarification;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.genai.common.DownloadCallback;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.GenAiException;
import com.google.mlkit.genai.prompt.CountTokensResponse;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import com.google.mlkit.genai.prompt.Generation;
import com.google.mlkit.genai.prompt.TextPart;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Keeps beta4's Kotlin 2.3 metadata behind its supported Java/Futures API so
 * the Expo app can retain its Kotlin 2.1 compiler for this bounded evaluation.
 */
class MlKitNanoClient {
  private static final int MAX_INPUT_TOKENS = 4_000;
  private static final int MAX_OUTPUT_TOKENS = 512;
  private final GenerativeModelFutures model;
  private final ClarifyDriver clarifyDriver;

  MlKitNanoClient() {
    model = GenerativeModelFutures.from(Generation.INSTANCE.getClient());
    clarifyDriver = new ClarifyDriver() {
      @Override
      public ListenableFuture<CountTokensResponse> countTokens(GenerateContentRequest request) {
        return model.countTokens(request);
      }

      @Override
      public ListenableFuture<GenerateContentResponse> generateContent(GenerateContentRequest request) {
        return model.generateContent(request);
      }
    };
  }

  MlKitNanoClient(ClarifyDriver clarifyDriver) {
    this.model = null;
    this.clarifyDriver = clarifyDriver;
  }

  MlKitNanoClient(boolean testOnly) {
    this.model = null;
    this.clarifyDriver = null;
  }

  CompletableFuture<String> status() {
    return map(model.checkStatus(), status -> {
      switch (status) {
        case FeatureStatus.AVAILABLE:
          return "available";
        case FeatureStatus.DOWNLOADABLE:
          return "downloadable";
        case FeatureStatus.DOWNLOADING:
          return "downloading";
        default:
          return "unavailable";
      }
    });
  }

  CompletableFuture<String> modelName() {
    return map(model.getBaseModelName(), value -> value);
  }

  CompletableFuture<Void> download() {
    return map(model.download(new DownloadCallback() {}), value -> null);
  }

  CompletableFuture<String> clarify(String prompt) {
    GenerateContentRequest.Builder builder = new GenerateContentRequest.Builder(new TextPart(prompt));
    builder.setTemperature(0.2f);
    builder.setTopK(10);
    builder.setCandidateCount(1);
    builder.setMaxOutputTokens(MAX_OUTPUT_TOKENS);
    GenerateContentRequest request = builder.build();

    CompletableFuture<String> result = new CompletableFuture<>();
    Object activeLock = new Object();
    AtomicReference<ListenableFuture<?>> active = new AtomicReference<>();
    ListenableFuture<CountTokensResponse> tokenFuture = clarifyDriver.countTokens(request);
    active.set(tokenFuture);
    tokenFuture.addListener(() -> {
      if (result.isCancelled()) return;
      try {
        int totalTokens = tokenFuture.get().getTotalTokens();
        if (totalTokens >= MAX_INPUT_TOKENS) {
          result.completeExceptionally(new RequestTooLargeException());
          return;
        }
        ListenableFuture<GenerateContentResponse> generationFuture;
        synchronized (activeLock) {
          if (result.isCancelled()) return;
          generationFuture = clarifyDriver.generateContent(request);
          active.set(generationFuture);
        }
        generationFuture.addListener(() -> {
          if (result.isCancelled()) return;
          try {
            GenerateContentResponse response = generationFuture.get();
            String text = response.getCandidates().isEmpty()
                ? null
                : response.getCandidates().get(0).getText();
            if (text == null || text.trim().isEmpty()) {
              result.completeExceptionally(new EmptyResponseException());
            } else {
              result.complete(text);
            }
          } catch (Throwable error) {
            result.completeExceptionally(unwrap(error));
          }
        }, Runnable::run);
      } catch (Throwable error) {
        result.completeExceptionally(unwrap(error));
      }
    }, Runnable::run);
    result.whenComplete((value, error) -> {
      if (result.isCancelled()) {
        synchronized (activeLock) {
          ListenableFuture<?> current = active.get();
          if (current != null) current.cancel(true);
        }
      }
    });
    return result;
  }

  void close() {
    if (model != null) model.getGenerativeModel().close();
  }

  static String reasonFor(Throwable error, boolean download) {
    Throwable cause = unwrap(error);
    if (cause instanceof RequestTooLargeException || cause instanceof EmptyResponseException) {
      return "unknown";
    }
    if (!(cause instanceof GenAiException)) return download ? "download_failed" : "unknown";
    switch (((GenAiException) cause).getErrorCode()) {
      case GenAiException.ErrorCode.CANCELLED:
        return "cancelled";
      case GenAiException.ErrorCode.BUSY:
        return "busy";
      case GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED:
        return "quota_exceeded";
      case GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED:
        return "background_blocked";
      case GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE:
        return "unsupported_os";
      case GenAiException.ErrorCode.NOT_SUPPORTED:
        return "locale_not_supported";
      case GenAiException.ErrorCode.NOT_AVAILABLE:
      case GenAiException.ErrorCode.AICORE_INCOMPATIBLE:
        return "unavailable";
      default:
        return download ? "download_failed" : "unknown";
    }
  }

  private static <T, R> CompletableFuture<R> map(
      ListenableFuture<T> source,
      Mapper<T, R> mapper) {
    CompletableFuture<R> result = new CompletableFuture<>();
    source.addListener(() -> {
      try {
        result.complete(mapper.map(source.get()));
      } catch (Throwable error) {
        result.completeExceptionally(unwrap(error));
      }
    }, Runnable::run);
    result.whenComplete((value, error) -> {
      if (result.isCancelled()) source.cancel(true);
    });
    return result;
  }

  private static Throwable unwrap(Throwable error) {
    Throwable current = error;
    while ((current instanceof ExecutionException || current instanceof CompletionException)
        && current.getCause() != null) {
      current = current.getCause();
    }
    return current;
  }

  private interface Mapper<T, R> {
    R map(T value) throws Exception;
  }

  interface ClarifyDriver {
    ListenableFuture<CountTokensResponse> countTokens(GenerateContentRequest request);
    ListenableFuture<GenerateContentResponse> generateContent(GenerateContentRequest request);
  }

  private static final class RequestTooLargeException extends Exception {}
  private static final class EmptyResponseException extends Exception {}
}
