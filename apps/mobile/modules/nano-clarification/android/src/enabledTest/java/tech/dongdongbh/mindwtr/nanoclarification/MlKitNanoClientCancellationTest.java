package tech.dongdongbh.mindwtr.nanoclarification;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.genai.prompt.CountTokensResponse;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class MlKitNanoClientCancellationTest {
  @Test
  public void cancelBeforeTokenCountCompletesNeverStartsGeneration() {
    TestFuture<CountTokensResponse> countFuture = new TestFuture<>();
    AtomicInteger generateCalls = new AtomicInteger();
    MlKitNanoClient client = new MlKitNanoClient(new MlKitNanoClient.ClarifyDriver() {
      @Override
      public ListenableFuture<CountTokensResponse> countTokens(GenerateContentRequest request) {
        return countFuture;
      }

      @Override
      public ListenableFuture<GenerateContentResponse> generateContent(GenerateContentRequest request) {
        generateCalls.incrementAndGet();
        return new TestFuture<>();
      }
    });

    CompletableFuture<String> result = client.clarify("complete prompt");
    result.cancel(true);
    countFuture.complete(new CountTokensResponse(10));

    assertTrue(result.isCancelled());
    assertEquals(0, generateCalls.get());
  }

  @Test
  public void cancellationDuringGenerationRegistrationCancelsTheNewFuture() throws Exception {
    TestFuture<CountTokensResponse> countFuture = new TestFuture<>();
    TestFuture<GenerateContentResponse> generationFuture = new TestFuture<>();
    CountDownLatch generateEntered = new CountDownLatch(1);
    CountDownLatch releaseGenerate = new CountDownLatch(1);
    MlKitNanoClient client = new MlKitNanoClient(new MlKitNanoClient.ClarifyDriver() {
      @Override
      public ListenableFuture<CountTokensResponse> countTokens(GenerateContentRequest request) {
        return countFuture;
      }

      @Override
      public ListenableFuture<GenerateContentResponse> generateContent(GenerateContentRequest request) {
        generateEntered.countDown();
        try {
          if (!releaseGenerate.await(5, TimeUnit.SECONDS)) throw new AssertionError("release timed out");
        } catch (InterruptedException error) {
          Thread.currentThread().interrupt();
          throw new AssertionError(error);
        }
        return generationFuture;
      }
    });
    CompletableFuture<String> result = client.clarify("complete prompt");

    Thread countCompletion = new Thread(
        () -> countFuture.complete(new CountTokensResponse(10)),
        "nano-count-completion");
    countCompletion.start();
    assertTrue("generation registration did not start", generateEntered.await(5, TimeUnit.SECONDS));

    Thread cancellation = new Thread(() -> result.cancel(true), "nano-cancellation");
    cancellation.start();
    releaseGenerate.countDown();
    countCompletion.join(5_000);
    cancellation.join(5_000);

    assertTrue(result.isCancelled());
    assertTrue("newly registered generation must be cancelled", generationFuture.isCancelled());
  }

  private static final class TestFuture<T> implements ListenableFuture<T> {
    private final List<Listener> listeners = new ArrayList<>();
    private boolean done;
    private boolean cancelled;
    private T value;

    synchronized void complete(T result) {
      if (done) return;
      value = result;
      done = true;
      notifyAll();
      runListeners();
    }

    @Override
    public synchronized void addListener(Runnable listener, Executor executor) {
      if (done) {
        executor.execute(listener);
      } else {
        listeners.add(new Listener(listener, executor));
      }
    }

    @Override
    public synchronized boolean cancel(boolean mayInterruptIfRunning) {
      if (done) return false;
      cancelled = true;
      done = true;
      notifyAll();
      runListeners();
      return true;
    }

    @Override
    public synchronized boolean isCancelled() {
      return cancelled;
    }

    @Override
    public synchronized boolean isDone() {
      return done;
    }

    @Override
    public synchronized T get() throws InterruptedException, ExecutionException {
      while (!done) wait();
      if (cancelled) throw new CancellationException();
      return value;
    }

    @Override
    public synchronized T get(long timeout, TimeUnit unit)
        throws InterruptedException, ExecutionException, TimeoutException {
      long remainingMillis = unit.toMillis(timeout);
      long deadline = System.currentTimeMillis() + remainingMillis;
      while (!done && remainingMillis > 0) {
        wait(remainingMillis);
        remainingMillis = deadline - System.currentTimeMillis();
      }
      if (!done) throw new TimeoutException();
      if (cancelled) throw new CancellationException();
      return value;
    }

    private void runListeners() {
      List<Listener> pending = new ArrayList<>(listeners);
      listeners.clear();
      for (Listener listener : pending) listener.executor.execute(listener.runnable);
    }
  }

  private static final class Listener {
    final Runnable runnable;
    final Executor executor;

    Listener(Runnable runnable, Executor executor) {
      this.runnable = runnable;
      this.executor = executor;
    }
  }
}
