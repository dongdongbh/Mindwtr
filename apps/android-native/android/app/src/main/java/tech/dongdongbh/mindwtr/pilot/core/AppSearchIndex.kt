package tech.dongdongbh.mindwtr.pilot.core

// RN's AppSearch index (apps/mobile/modules/app-search/.../MindwtrAppSearchIndex.kt), copied as it is (pass O2d): the same
// database, namespace and schema names, so an upgraded RN user's index is this app's, and a wipe here clears RN's documents.
// Only the package changed, and [ids] (a debug read for the device check) was added.

import android.content.Context
import android.os.Build
import androidx.appsearch.app.AppSearchSchema
import androidx.appsearch.app.AppSearchSession
import androidx.appsearch.app.GenericDocument
import androidx.appsearch.app.PutDocumentsRequest
import androidx.appsearch.app.RemoveByDocumentIdRequest
import androidx.appsearch.app.SearchResult
import androidx.appsearch.app.SearchSpec
import androidx.appsearch.app.SetSchemaRequest
import androidx.appsearch.platformstorage.PlatformStorage
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.Executor

private const val DATABASE_NAME = "mindwtr_search"
private const val NAMESPACE = "mindwtr"
private const val SCHEMA_TYPE = "MindwtrItem"

private const val PROP_KIND = "kind"
private const val PROP_TITLE = "title"
private const val PROP_STATUS = "status"
private const val PROP_DUE_DATE = "dueDate"
private const val PROP_PARENT_ID = "parentId"
private const val PROP_DEEP_LINK = "deepLink"

// ListenableFuture.addListener(Runnable, Executor) is part of the base
// interface, so a same-thread executor avoids pulling in Guava's `Futures`
// utility class (and its full jar) just to attach a completion callback.
private val directExecutor = Executor { it.run() }

/**
 * TS-facing shape for a single document to index. Mirrors
 * `apps/mobile/lib/app-search-projection.ts`'s `AppSearchDoc` — kept as a
 * loosely-typed map here because that is what crosses the Expo bridge.
 */
data class MindwtrAppSearchDoc(
  val id: String,
  val kind: String,
  val title: String,
  val status: String?,
  val dueDate: String?,
  val parentId: String?,
  val deepLink: String,
) {
  companion object {
    fun fromMap(raw: Map<String, Any?>): MindwtrAppSearchDoc? {
      val id = raw["id"] as? String ?: return null
      val kind = raw["kind"] as? String ?: return null
      val title = raw["title"] as? String ?: return null
      val deepLink = raw["deepLink"] as? String ?: return null
      return MindwtrAppSearchDoc(
        id = id,
        kind = kind,
        title = title,
        status = raw["status"] as? String,
        dueDate = raw["dueDate"] as? String,
        parentId = raw["parentId"] as? String,
        deepLink = deepLink,
      )
    }
  }
}

/**
 * Owns the single process-wide AppSearch session and schema for the
 * disposable-projection secondary index described in #1017. AppSearch
 * failures here must never propagate into a core-data mutation path — every
 * public entry point reports success/failure only to its own caller.
 */
object MindwtrAppSearchIndex {
  fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

  @Volatile
  private var sessionFuture: ListenableFuture<AppSearchSession>? = null

  @Volatile
  private var schemaReady = false

  private fun buildSchema(): AppSearchSchema {
    return AppSearchSchema.Builder(SCHEMA_TYPE)
      .addProperty(
        AppSearchSchema.StringPropertyConfig.Builder(PROP_TITLE)
          .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_REQUIRED)
          .setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES)
          .setTokenizerType(AppSearchSchema.StringPropertyConfig.TOKENIZER_TYPE_PLAIN)
          .build()
      )
      .addProperty(
        AppSearchSchema.StringPropertyConfig.Builder(PROP_KIND)
          .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_REQUIRED)
          .setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_EXACT_TERMS)
          .setTokenizerType(AppSearchSchema.StringPropertyConfig.TOKENIZER_TYPE_PLAIN)
          .build()
      )
      .addProperty(
        AppSearchSchema.StringPropertyConfig.Builder(PROP_STATUS)
          .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL)
          .setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_EXACT_TERMS)
          .setTokenizerType(AppSearchSchema.StringPropertyConfig.TOKENIZER_TYPE_PLAIN)
          .build()
      )
      .addProperty(
        AppSearchSchema.StringPropertyConfig.Builder(PROP_DUE_DATE)
          .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL)
          .build()
      )
      .addProperty(
        AppSearchSchema.StringPropertyConfig.Builder(PROP_PARENT_ID)
          .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL)
          .build()
      )
      .addProperty(
        AppSearchSchema.StringPropertyConfig.Builder(PROP_DEEP_LINK)
          .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_REQUIRED)
          .build()
      )
      .build()
  }

  private fun getSession(context: Context): ListenableFuture<AppSearchSession> {
    sessionFuture?.let { return it }
    synchronized(this) {
      sessionFuture?.let { return it }
      val searchContext = PlatformStorage.SearchContext.Builder(context.applicationContext, DATABASE_NAME).build()
      val created = PlatformStorage.createSearchSessionAsync(searchContext)
      sessionFuture = created
      return created
    }
  }

  /** Runs [action] once the session exists and the schema is registered; reports failures via [onError]. */
  private fun withReadySession(context: Context, onError: (Throwable) -> Unit, action: (AppSearchSession) -> Unit) {
    val future = getSession(context)
    future.addListener({
      try {
        val session = future.get()
        if (schemaReady) {
          action(session)
          return@addListener
        }
        val schemaFuture = session.setSchemaAsync(SetSchemaRequest.Builder().addSchemas(buildSchema()).build())
        schemaFuture.addListener({
          try {
            schemaFuture.get()
            schemaReady = true
            action(session)
          } catch (error: Throwable) {
            onError(error)
          }
        }, directExecutor)
      } catch (error: Throwable) {
        onError(error)
      }
    }, directExecutor)
  }

  private fun toGenericDocument(doc: MindwtrAppSearchDoc): GenericDocument {
    val builder = GenericDocument.Builder<GenericDocument.Builder<*>>(NAMESPACE, doc.id, SCHEMA_TYPE)
      .setPropertyString(PROP_KIND, doc.kind)
      .setPropertyString(PROP_TITLE, doc.title)
      .setPropertyString(PROP_DEEP_LINK, doc.deepLink)
    doc.status?.let { builder.setPropertyString(PROP_STATUS, it) }
    doc.dueDate?.let { builder.setPropertyString(PROP_DUE_DATE, it) }
    doc.parentId?.let { builder.setPropertyString(PROP_PARENT_ID, it) }
    return builder.build()
  }

  fun upsert(context: Context, docs: List<MindwtrAppSearchDoc>, onDone: (Result<Unit>) -> Unit) {
    if (docs.isEmpty()) {
      onDone(Result.success(Unit))
      return
    }
    withReadySession(context, onError = { onDone(Result.failure(it)) }) { session ->
      val request = PutDocumentsRequest.Builder()
        .addGenericDocuments(docs.map(::toGenericDocument))
        .build()
      val putFuture = session.putAsync(request)
      putFuture.addListener({
        try {
          // Partial per-document failures live in the batch result and are
          // intentionally not surfaced as a hard error: a single malformed
          // document must never block the rest of the index update.
          putFuture.get()
          onDone(Result.success(Unit))
        } catch (error: Throwable) {
          onDone(Result.failure(error))
        }
      }, directExecutor)
    }
  }

  fun remove(context: Context, ids: List<String>, onDone: (Result<Unit>) -> Unit) {
    if (ids.isEmpty()) {
      onDone(Result.success(Unit))
      return
    }
    withReadySession(context, onError = { onDone(Result.failure(it)) }) { session ->
      val request = RemoveByDocumentIdRequest.Builder(NAMESPACE).addIds(ids).build()
      val removeFuture = session.removeAsync(request)
      removeFuture.addListener({
        try {
          removeFuture.get()
          onDone(Result.success(Unit))
        } catch (error: Throwable) {
          onDone(Result.failure(error))
        }
      }, directExecutor)
    }
  }

  /** Debug builds' device check: the ids of every document in this app's namespace (never titles), page by page. */
  fun ids(context: Context, onDone: (Result<List<String>>) -> Unit) {
    withReadySession(context, onError = { onDone(Result.failure(it)) }) { session ->
      val searchSpec = SearchSpec.Builder()
        .addFilterSchemas(SCHEMA_TYPE)
        .addFilterNamespaces(NAMESPACE)
        .setTermMatch(SearchSpec.TERM_MATCH_PREFIX)
        .setResultCountPerPage(100)
        .build()
      val results = session.search("", searchSpec)
      val ids = ArrayList<String>()
      fun next() {
        val page = results.nextPageAsync
        page.addListener({
          try {
            val got: List<SearchResult> = page.get()
            if (got.isEmpty()) {
              results.close()
              onDone(Result.success(ids))
            } else {
              got.mapTo(ids) { it.genericDocument.id }
              next()
            }
          } catch (error: Throwable) {
            results.close()
            onDone(Result.failure(error))
          }
        }, directExecutor)
      }
      next()
    }
  }

  /** Wipes every document this app has indexed — used on toggle-off and before a full reindex. */
  fun wipeAll(context: Context, onDone: (Result<Unit>) -> Unit) {
    withReadySession(context, onError = { onDone(Result.failure(it)) }) { session ->
      val searchSpec = SearchSpec.Builder()
        .addFilterSchemas(SCHEMA_TYPE)
        .addFilterNamespaces(NAMESPACE)
        .setTermMatch(SearchSpec.TERM_MATCH_PREFIX)
        .build()
      val removeFuture = session.removeAsync("", searchSpec)
      removeFuture.addListener({
        try {
          removeFuture.get()
          onDone(Result.success(Unit))
        } catch (error: Throwable) {
          onDone(Result.failure(error))
        }
      }, directExecutor)
    }
  }
}
