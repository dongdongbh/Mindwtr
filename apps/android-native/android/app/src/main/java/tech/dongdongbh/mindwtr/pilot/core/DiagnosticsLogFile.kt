package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import java.io.FileOutputStream


class DiagnosticsLogFile(val file: File) {
    companion object {

        const val RELATIVE_PATH = "logs/mindwtr.log"
    }


    fun run(operation: String, text: String): String = when (operation) {
        "path" -> file.path

        "ensure" -> {
            file.parentFile?.mkdirs()
            if (file.isDirectory) file.deleteRecursively()
            file.createNewFile()
            if (file.isFile) file.path else ""
        }
        "exists" -> if (file.isFile) "1" else ""
        "read" -> file.readText()
        "size" -> file.length().toString()

        "append" -> {
            FileOutputStream(file, true).use { it.write(text.toByteArray()) }
            ""
        }

        "write" -> {
            val partial = File(file.parentFile, "${file.name}.partial")
            FileOutputStream(partial).use { out -> out.write(text.toByteArray()); out.fd.sync() }
            check(partial.renameTo(file)) { "Cannot replace the diagnostics log" }
            ""
        }
        "delete" -> when {
            file.isFile -> if (file.delete()) "1" else ""
            file.isDirectory -> { file.deleteRecursively(); "" }
            else -> ""
        }

        "moveAside" -> {
            val aside = File(file.parentFile, "${file.name}.unreadable")
            aside.delete()
            check(file.renameTo(aside)) { "Cannot move the diagnostics log aside" }
            ""
        }
        else -> throw IllegalArgumentException("Unknown log operation $operation")
    }
}
