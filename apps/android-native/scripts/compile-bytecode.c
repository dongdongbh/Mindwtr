#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

static unsigned char *read_file(const char *path, size_t *length) {
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fseek(file, 0, SEEK_SET);
    unsigned char *bytes = malloc(size + 1);
    if (!bytes || fread(bytes, 1, size, file) != (size_t) size) { fclose(file); free(bytes); return NULL; }
    fclose(file);
    *length = size;
    return bytes;
}

static void put_unit(char *out, size_t *at, unsigned unit) {
    out[(*at)++] = (char) (0xe0 | (unit >> 12));
    out[(*at)++] = (char) (0x80 | ((unit >> 6) & 0x3f));
    out[(*at)++] = (char) (0x80 | (unit & 0x3f));
}

static char *jni_modified_utf8(const unsigned char *in, size_t length) {
    char *out = malloc(length * 2 + 1);
    size_t at = 0;
    for (size_t i = 0; i < length;) {
        unsigned char lead = in[i];
        size_t width = lead < 0x80 ? 1 : (lead & 0xe0) == 0xc0 ? 2 : (lead & 0xf0) == 0xe0 ? 3 : (lead & 0xf8) == 0xf0 ? 4 : 0;
        if (width == 0 || i + width > length) { free(out); return NULL; }
        for (size_t k = 1; k < width; k++) if ((in[i + k] & 0xc0) != 0x80) { free(out); return NULL; }
        if (lead == 0) {
            out[at++] = (char) 0xc0;
            out[at++] = (char) 0x80;
        } else if (width == 4) {
            unsigned point = ((lead & 0x07u) << 18) | ((in[i + 1] & 0x3fu) << 12) | ((in[i + 2] & 0x3fu) << 6) | (in[i + 3] & 0x3fu);
            if (point < 0x10000 || point > 0x10ffff) { free(out); return NULL; }
            point -= 0x10000;
            put_unit(out, &at, 0xd800 | (point >> 10));
            put_unit(out, &at, 0xdc00 | (point & 0x3ff));
        } else {
            memcpy(out + at, in + i, width);
            at += width;
        }
        i += width;
    }
    out[at] = 0;
    return out;
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: compile-bytecode <bundle.js> <file name> <out.bin>\n");
        return 2;
    }
    size_t length = 0;
    unsigned char *bundle = read_file(argv[1], &length);
    if (!bundle) { fprintf(stderr, "compile-bytecode: cannot read %s\n", argv[1]); return 1; }
    char *source = jni_modified_utf8(bundle, length);
    if (!source) { fprintf(stderr, "compile-bytecode: %s is not valid UTF-8\n", argv[1]); return 1; }

    JSRuntime *runtime = JS_NewRuntime();
    JS_SetStripInfo(runtime, JS_STRIP_SOURCE);
    JSContext *context = JS_NewContext(runtime);
    JSValue compiled = JS_Eval(context, source, strlen(source), argv[2], JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(compiled)) {
        JSValue error = JS_GetException(context);
        const char *message = JS_ToCString(context, error);
        fprintf(stderr, "compile-bytecode: %s\n", message ? message : "compile failed");
        return 1;
    }
    size_t size = 0;
    uint8_t *bytecode = JS_WriteObject(context, &size, compiled, JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_REFERENCE);
    FILE *out = fopen(argv[3], "wb");
    if (!bytecode || size == 0 || !out || fwrite(bytecode, 1, size, out) != size || fclose(out) != 0) {
        fprintf(stderr, "compile-bytecode: cannot write %s\n", argv[3]);
        return 1;
    }
    return 0;
}
