#!/usr/bin/env python3
"""Compile the real Kotlin queue against fake preferences; requires cached Gradle Kotlin/JSON jars."""
from pathlib import Path
from tempfile import TemporaryDirectory
import os
import subprocess

cache = Path.home() / '.gradle/caches/modules-2/files-2.1'

def jar(group, artifact, version):
    return str(next((cache / group / artifact / version).glob('**/*.jar')))

stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.20')
json = jar('org.json', 'json', '20240303')
compiler = os.pathsep.join([
    jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '1.9.25'), stdlib,
    jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.9.20'),
    jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'),
    jar('org.jetbrains', 'annotations', '13.0'),
])
source = Path(__file__).resolve().parents[1] / 'android/src/main/java/tech/dongdongbh/mindwtr/notificationopenintents/NotificationOpenPayloadStore.kt'
root = Path(os.environ.get('TMPDIR', str(Path.home() / 'build-tmp')))
root.mkdir(parents=True, exist_ok=True)
with TemporaryDirectory(prefix='pending-completions-', dir=root) as temporary:
    directory = Path(temporary)
    stub = directory / 'Context.kt'
    stub.write_text('''package android.content
class Context(val disk: MutableMap<String, String> = mutableMapOf()) {
  companion object { const val MODE_PRIVATE = 0 }
  var failCommit = false
  fun getSharedPreferences(name: String, mode: Int) = Preferences(this)
}
class Preferences(val context: Context) {
  fun getString(name: String, fallback: String?): String? = context.disk[name] ?: fallback
  fun edit() = Editor(context)
}
class Editor(val context: Context) {
  private val changes = mutableMapOf<String, String>()
  fun putString(name: String, value: String): Editor { changes[name] = value; return this }
  fun commit(): Boolean {
    if (context.failCommit) return false
    context.disk.putAll(changes)
    return true
  }
}
''')
    harness = directory / 'Check.kt'
    harness.write_text('''import android.content.Context
import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore as Store
fun rejected(operation: () -> Unit) { check(runCatching(operation).isFailure) }
fun main() {
  val context = Context()
  for (index in 0 until 75) Store.persistCompletion(context, mapOf("taskId" to "task-$index", "alarmKey" to "alarm-$index"))
  Store.persistCompletion(context, mapOf("taskId" to "task-0", "alarmKey" to "alarm-0"))
  check(Store.peekCompletions(context).size == 75)
  val raw = context.disk["pendingCompletions"]
  check(Store.peekCompletions(context).size == 75)
  check(context.disk["pendingCompletions"] == raw)
  // Recreate all preference ownership from the durable image after the read.
  val recreated = Context(context.disk.toMutableMap())
  check(Store.peekCompletions(recreated).size == 75)
  val first = Store.peekCompletions(recreated).first()["actionId"]!!
  recreated.failCommit = true
  rejected { Store.acknowledgeCompletion(recreated, first) }
  rejected { Store.persistCompletion(recreated, mapOf("taskId" to "new")) }
  check(recreated.disk["pendingCompletions"] == raw)
  recreated.failCommit = false
  Store.acknowledgeCompletion(recreated, first)
  check(Store.peekCompletions(Context(recreated.disk.toMutableMap())).size == 74)
  for (bad in listOf("broken json", "[3]", "[{}]")) {
    recreated.disk["pendingCompletions"] = bad
    rejected { Store.peekCompletions(recreated) }
    rejected { Store.persistCompletion(recreated, mapOf("taskId" to "new")) }
    rejected { Store.acknowledgeCompletion(recreated, first) }
    check(recreated.disk["pendingCompletions"] == bad)
  }
  recreated.disk["pendingCompletions"] = "[{\\"taskId\\":\\"old\\"}]"
  val migrated = Store.peekCompletions(recreated).single()["actionId"]!!
  check(Store.peekCompletions(Context(recreated.disk.toMutableMap())).single()["actionId"] == migrated)
  Store.acknowledgeCompletion(recreated, migrated)
  check(Store.peekCompletions(recreated).isEmpty())
  println("PASS: 75 durable receipts, duplicate, read/recreation, failed append/ack commits, corrupt JSON retained, legacy acknowledgement")
}
''')
    output = directory / 'classes'
    subprocess.run(['java', '-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
                    '-no-stdlib', '-no-reflect', '-classpath', os.pathsep.join([stdlib, json]),
                    str(stub), str(source), str(harness), '-d', str(output)], check=True)
    subprocess.run(['java', '-cp', os.pathsep.join([str(output), stdlib, json]), 'CheckKt'], check=True)
