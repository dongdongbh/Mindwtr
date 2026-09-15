package tech.dongdongbh.mindwtr.nanoclarification

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletableFuture

class MlKitNanoClarificationBackendCancellationTest {
  @Test
  fun statusCancellationIsNotConvertedToAnUnknownCapability() = runBlocking {
    val pending = CompletableFuture<String>()
    val entered = CompletableDeferred<Unit>()
    val client = object : MlKitNanoClient(true) {
      override fun status(): CompletableFuture<String> {
        entered.complete(Unit)
        return pending
      }
    }
    val backend = MlKitNanoClarificationBackend(client, sdkInt = { 26 })
    var returned = false
    val operation = async {
      backend.getCapability("en-US")
      returned = true
    }

    entered.await()
    operation.cancelAndJoin()

    assertTrue(operation.isCancelled)
    assertTrue(pending.isCancelled)
    assertFalse(returned)
  }

  @Test
  fun inferenceCancellationIsNotConvertedToUnknown() = runBlocking {
    val pending = CompletableFuture<String>()
    val entered = CompletableDeferred<Unit>()
    val client = object : MlKitNanoClient(true) {
      override fun status(): CompletableFuture<String> =
        CompletableFuture.completedFuture("available")

      override fun clarify(prompt: String): CompletableFuture<String> {
        entered.complete(Unit)
        return pending
      }
    }
    val backend = MlKitNanoClarificationBackend(client, sdkInt = { 26 })
    var returned = false
    val operation = async {
      backend.clarify("complete prompt")
      returned = true
    }

    entered.await()
    operation.cancelAndJoin()

    assertTrue(operation.isCancelled)
    assertTrue(pending.isCancelled)
    assertFalse(returned)
  }
}
