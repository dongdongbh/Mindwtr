package tech.dongdongbh.mindwtr.nanoclarification;

import java.util.concurrent.CancellationException;
import kotlinx.coroutines.Job;
import kotlinx.coroutines.JobKt;
import org.junit.Test;
import static org.junit.Assert.assertTrue;

public class MlKitRuntimeCompatibilityTest {
  @Test
  public void sdkDefaultCancellationEntryPointExistsAndCancels() throws Exception {
    // Prompt beta4 invokes this JVM-default bridge from its cancellation code.
    // Older coroutine runtimes compile and package but crash on a real device.
    Job job = JobKt.Job(null);
    Job.class.getDeclaredMethod(
        "cancel$default", Job.class, CancellationException.class, int.class, Object.class
    ).invoke(null, job, null, 1, null);
    assertTrue(job.isCancelled());
  }
}
