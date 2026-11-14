#ifndef QUICKJS_EXTEND_LIBRARIES
#define QUICKJS_EXTEND_LIBRARIES

#include <string>
#include <cstring>
#include "../quickjs/quickjs.h"

const char *DATE_POLYFILL = R"lit((() => {
    const _Date = Date;
    // use _Date avoid recursion in _parse.
    const _parse = (date) => {
        if (date === null) {
            // null is invalid
            return new _Date(NaN);
        }
        if (date === undefined) {
            // today
            return new _Date();
        }
        if (date instanceof Date) {
            return new _Date(date);
        }

        if (typeof date === 'string' && !/Z$/i.test(date)) {
            // YYYY-MM-DD HH:mm:ss.sssZ
            const d = date.match(/^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/);
            if (d) {
                let YYYY = d[1];
                let MM = d[2] - 1 || 0;
                let DD = d[3] || 1;

                const HH = d[4] || 0;
                const mm = d[5] || 0;
                const ss = d[6] || 0;
                const sssZ = (d[7] || '0').substring(0, 3);

                // Consider that only date strings (such as "1970-01-01") will be processed as UTC instead of local time.
                let utc = (d[4] === undefined) && (d[5] === undefined) && (d[6] === undefined) && (d[7] === undefined);
                if (utc) {
                    return new Date(Date.UTC(YYYY, MM, DD, HH, mm, ss, sssZ));
                }
                return new Date(YYYY, MM, DD, HH, mm, ss, sssZ);
            }
        }

        // everything else
        return new _Date(date);
    };

    const handler = {
        construct: function (target, args) {
            if (args.length === 1 && typeof args[0] === 'string') {
                return _parse(args[0]);
            }

            return new target(...args);
        },
        get(target, prop) {
            if (typeof target[prop] === 'function' && target[prop].name === 'parse') {
                return new Proxy(target[prop], {
                    apply: (target, thisArg, argumentsList) => {
                        if (argumentsList.length === 1 && typeof argumentsList[0] === 'string') {
                            return _parse(argumentsList[0]).getTime();
                        }

                        return Reflect.apply(target, thisArg, argumentsList);
                    }
                });
            } else {
                return Reflect.get(target, prop);
            }
        }
    };

    Date = new Proxy(Date, handler);
})();)lit";

const char *CONSOLE = R"lit(// Init format at first.
{
    const LINE = "\n"
    const TAB = "  "
    const SPACE = " "

    function format(value, opt) {
        const defaultOpt = {
            maxStringLength: 10000,
            depth: 2,
            maxArrayLength: 100,
            seen: [],
            reduceStringLength: 100
        }
        if (!opt) {
            opt = defaultOpt
        } else {
            opt = Object.assign(defaultOpt, opt)
        }

        return formatValue(value, opt, 0)
    }

    function formatValue(value, opt, recurseTimes) {
        if (typeof value !== 'object' && typeof value !== 'function') {
            return formatPrimitive(value, opt)
        }

        if (value === null) {
            return 'null'
        }

        if (typeof value === 'function') {
            return formatFunction(value)
        }

        if (typeof value === 'object') {
            if (opt.seen.includes(value)) {
                let index = 1
                if (opt.circular === undefined) {
                    opt.circular = new Map()
                    opt.circular.set(value, index)
                } else {
                    index = opt.circular.get(value)
                    if (index === undefined) {
                        index = opt.circular.size + 1
                        opt.circular.set(value, index)
                    }
                }

                return `[Circular *${index}]`
            }

            if (opt.depth !== null && ((recurseTimes - 1) === opt.depth)) {
                if (value instanceof Array) {
                    return '[Array]'
                }
                return '[Object]'
            }

            recurseTimes++
            opt.seen.push(value)
            const string = formatObject(value, opt, recurseTimes)
            opt.seen.pop()
            return string
        }
    }

    function formatObject(value, opt, recurseTimes) {
        if (value instanceof RegExp) {
            return `${value.toString()}`
        }

        if (value instanceof Error) {
            return `${value.toString()}`
        }

        if (value instanceof Promise) {
            // quickjs 环境下通过 native 提供的方式获取 Promise 状态
            if (typeof getPromiseState !== "undefined") {
                const { result, state} = getPromiseState(value)
                if (state === 'fulfilled') {
                    return `Promise { ${formatValue(result, opt, recurseTimes)} }`
                } else if (state === 'rejected'){
                    return `Promise { <rejected> ${formatValue(result, opt, recurseTimes)} }`
                } else if (state === 'pending'){
                    return `Promise { <pending> }`
                }
            } else {
                return `Promise {${formatValue(value, opt, recurseTimes)}}`
            }
        }

        if (value instanceof Array) {
            return formatArray(value, opt, recurseTimes)
        }

        if (value instanceof Float64Array) {
            return `Float64Array(1) [ ${value} ]`
        }

        if (value instanceof BigInt64Array) {
            return `BigInt64Array(1) [ ${value}n ]`
        }

        if (value instanceof Map) {
            return formatMap(value, opt, recurseTimes)
        }

        return formatProperty(value, opt, recurseTimes)
    }

    function formatProperty(value, opt, recurseTimes) {
        let string = ''
        string += '{'
        const keys = Object.keys(value)
        const length = keys.length
        for (let i = 0; i < length; i++) {
            if (i === 0) {
                string += SPACE
            }
            string += LINE
            string += TAB.repeat(recurseTimes)

            const key = keys[i]
            string += `${key}: `
            string += formatValue(value[key], opt, recurseTimes)
            if (i < length -1) {
                string += ','
            }
            string += SPACE
        }

        string += LINE
        string += TAB.repeat(recurseTimes - 1)
        string += '}'

        if (string.length < opt.reduceStringLength) {
            string = string.replaceAll(LINE, "").replaceAll(TAB, "")
        }

        return string
    }

    function formatMap(value, opt, recurseTimes) {
        let string = `Map(${value.size}) `
        string += '{'
        let isEmpty = true
        value.forEach((v, k, map) => {
            isEmpty = false
            string += ` ${format(k, opt, recurseTimes)} => ${format(v, opt, recurseTimes)}`
            string += ','
        })

        if (!isEmpty) {
            // 删除最后多余的逗号
            string = string.substr(0, string.length -1) + ' '
        }

        string += '}'
        return string
    }

    function formatArray(value, opt, recurseTimes) {
        let string = '['
        value.forEach((item, index, array) => {
            if (index === 0) {
                string += ' '
            }
            string += formatValue(item, opt, recurseTimes)
            if (index === opt.maxArrayLength - 1) {
                string += `... ${array.length - opt.maxArrayLength} more item${array.length - opt.maxArrayLength > 1 ? 's' : ''}`
            } else if (index !== array.length - 1) {
                string += ','
            }
            string += ' '
        })
        string += ']'
        return string
    }

    function formatFunction(value) {
        let type = 'Function'

        if (value.constructor.name === 'AsyncFunction') {
            type = 'AsyncFunction'
        }

        if (value.constructor.name === 'GeneratorFunction') {
            type = 'GeneratorFunction'
        }

        if (value.constructor.name === 'AsyncGeneratorFunction') {
            type = 'AsyncGeneratorFunction'
        }

        let fn = `${value.name ? `: ${value.name}` : ' (anonymous)'}`
        return `[${type + fn}]`
    }

    function formatPrimitive(value, opt) {
        const type = typeof value
        switch (type) {
            case "string":
                return formatString(value, opt)
            case "number":
                return Object.is(value, -0) ? '-0' : `${value}`
            case "bigint":
                return `${String(value)}n`
            case "boolean":
                return `${value}`
            case "undefined":
                return "undefined"
            case "symbol":
                return `${value.toString()}`
            default:
                return value.toString
        }
    }

    function formatString(value, opt) {
        let trailer = ''
        if (opt.maxStringLength && value.length > opt.maxStringLength) {
            const remaining = value.length - opt.maxStringLength
            value = value.slice(0, opt.maxStringLength)
            trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`
        }

        return `'${value}'${trailer}`
    }

    globalThis.format = format
}

// Then console init.
{
    globalThis.console = {
        stdout: function (level, msg) {
            throw new Error("When invoke console stuff, you should be set a stdout of platform to console.stdout.")
        },
        log: function (...args) {
            this.print("log", ...args)
        },
        debug: function(...args) {
            this.print("debug", ...args)
        },
        info: function (...args) {
            this.print("info", ...args)
        },
        warn: function (...args) {
            this.print("warn", ...args)
        },
        error: function (...args) {
            this.print("error", ...args)
        },
        print: function (level, ...args) {
            let msg = ''
            args.forEach((value, index) => {
                if (index > 0) {
                    msg += ", "
                }

                msg += globalThis.format(value)
            })

            this.stdout(level, msg)
        }
    }
})lit";


static inline void loadExtendLibraries(JSContext *ctx) {
    JS_FreeValue(ctx, JS_Eval(ctx, DATE_POLYFILL, strlen(DATE_POLYFILL), "date-polyfill.js", JS_EVAL_TYPE_GLOBAL));
    JS_FreeValue(ctx, JS_Eval(ctx, CONSOLE, strlen(CONSOLE), "console.js", JS_EVAL_TYPE_GLOBAL));
}

#endif //QUICKJS_EXTEND_LIBRARIES