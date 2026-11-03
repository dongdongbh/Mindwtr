package tech.dongdongbh.mindwtr.appsearch

import android.content.Context
import android.os.Build
import androidx.appsearch.app.AppSearchSchema
import androidx.appsearch.app.AppSearchSession
import androidx.appsearch.app.GenericDocument
import androidx.appsearch.app.PutDocumentsRequest
import androidx.appsearch.app.RemoveByDocumentIdRequest
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


private val directExecutor = Executor { it.run() }


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
