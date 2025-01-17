function createReader() {
    return () => {
        // return prompt("Input number to be passed to read() call, press Cancel when done")
        return null
    }
}

function createWriter() {
    return (str) => {
        document.getElementById('output').innerText += str
    }
}

function createLoader() {
    return (path, runtime) => WebAssembly.instantiateStreaming(fetch(path), runtime)
}

function de_hash(hash) {
    const chars = "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'"
    const result = []

    while (hash != 0) {
        result.unshift(chars[hash & 0b00111111])
        hash = hash >> 6
    }

    return result.join("")
}

class LamaRuntime {
    lastAddress = 0
    addressSpace = new Map()
    regexps = []
    readLine = createReader()
    puts = createWriter()
    loadModule = createLoader()

    constructor(std_path, stdlib_path) {
        this.std_path = std_path
        this.stdlib_path = stdlib_path || std_path
    }

    async initialize(extern) {
        this.runtime = {
            "Std": {
                "write": (_, num) => {
                    this.puts(num + "\n")
                    return 0
                },
                "read": (_) => {
                    return parseInt(this.readLine())
                },
                "readLine": (_) => {
                    const line = this.readLine()
                    return line == null ? 0 : this.internalizeString(line)
                },
                "printf": (_, args) => {
                    args = this.externalizeArray(args)
                    this.puts(this.basePrintf(args))
                    return 0
                },
                "sprintf": (_, args) => {
                    args = this.externalizeArray(args)
                    return this.internalizeString(this.basePrintf(args))
                },
                "failure": (_, args) => {
                    args = this.externalizeArray(args)
                    throw new Error(this.basePrintf(args))
                },
                "string": (_, arg) => {
                    const inner = (arg) => {
                        if (typeof arg == "number") {
                            return arg.toString()
                        }
                        if (this.runtime.Std.is_string(arg)) {
                            const str = this.externalizeString(arg)
                            return `"${str}"`
                        }
                        if (this.runtime.Std.is_closure(arg)) {
                            const vals = this.externalizeClosure(arg)
                            const strs = vals.map(v => inner(v))
                            return `<closure ${strs.join(", ")}>`
                        }
                        if (this.runtime.Std.is_array(arg)) {
                            const vals = this.externalizeArray(arg)
                            const strs = vals.map(v => inner(v))
                            return `[${strs.join(", ")}]`
                        }
                        if (this.runtime.Std.is_sexp(arg)) {
                            const [tag, vals] = this.externalizeSexp(arg)
                            if (tag == "cons") {
                                const elems = [vals[0]]
                                let next = vals[1]
                                while (this.runtime.Std.is_sexp(next)) {
                                    const [_, nextVals] = this.externalizeSexp(next)
                                    elems.push(nextVals[0])
                                    next = nextVals[1]
                                }
                                const strs = elems.map(v => inner(v))
                                return `{${strs.join(", ")}}`
                            } else {
                                const strs = vals.map(v => inner(v))
                                return tag + (strs.length > 0 ? ` (${strs.join(", ")})` : "")
                            }
                        }
                        return "*** invalid data_header ***"
                    }

                    return this.internalizeString(inner(arg))
                },
                "stringcat": (_, arg) => {
                    const inner = (arg) => {
                        if (typeof arg == "number") {
                            return ""
                        }
                        if (this.runtime.Std.is_string(arg)) {
                            return this.externalizeString(arg)
                        }
                        if (this.runtime.Std.is_sexp(arg)) {
                            const [tag, vals] = this.externalizeSexp(arg)
                            if (tag == "cons") {
                                const elems = [vals[0]]
                                let next = vals[1]
                                while (this.runtime.Std.is_sexp(next)) {
                                    const [_, nextVals] = this.externalizeSexp(next)
                                    elems.push(nextVals[0])
                                    next = nextVals[1]
                                }
                                const strs = elems.map(v => inner(v))
                                return strs.join("")
                            } else {
                                return `*** non-list data_header: ${tag} ***`
                            }
                        }
                        return "*** invalid data_header ***"
                    }

                    return this.internalizeString(inner(arg))
                },
                "flatCompare": (_, p, q) => {
                    if (typeof p === "number") {
                        if (typeof q === "number") {
                            return p - q
                        }
                        return -1;
                    }
                    if (typeof q === "number") {
                        return 1
                    }

                    if (!this.addressSpace.has(p)) this.addressSpace.set(p, this.lastAddress++)
                    if (!this.addressSpace.has(q)) this.addressSpace.set(q, this.lastAddress++)
                    return this.addressSpace.get(p) - this.addressSpace.get(q)
                },
                "regexp": (_, pattern) => {
                    const regexp = new RegExp(this.externalizeString(pattern))
                    this.regexps.push(regexp)
                    return this.regexps.length - 1
                },
                "regexpMatch": (_, pointer, haystack, start) => {
                    const string = this.externalizeString(haystack)
                    if (start < 0 || start > string.length) return -1
                    const regexp = this.regexps[pointer]
                    const result = regexp.exec(string.slice(start))
                    return (result && result.index == 0) ? result[0].length : -1
                },
                "matchSubString": (_, subj, patt, pos) => {
                    subj = this.externalizeString(subj)
                    patt = this.externalizeString(patt)
                    return +subj.startsWith(patt, pos)
                },
                "random": (_, to) => {
                    return Math.floor(Math.random() * to)
                },
                "time": (_) => {
                    return Math.floor(performance.now() * 1000)
                },
                "stringInt": (_, arg) => {
                    const res = parseInt(this.externalizeString(arg))
                    if (res) return res
                    else return 0
                },
                "uppercase": (_, char) => {
                    return String.fromCharCode(char).toUpperCase().charCodeAt(0)
                },
                "lowercase": (_, char) => {
                    return String.fromCharCode(char).toLowerCase().charCodeAt(0)
                }
            }
        }

        if (extern) {
            this.runtime.extern = extern
        }

        const stdModule = await this.loadModule(this.std_path + "/Std.wasm", this.runtime)
        this.runtime.Std = { ...this.runtime.Std, ...stdModule.instance.exports }

        await this.loadLib("Lazy")
        await this.loadLib("Ref")
        await this.loadLib("Fun")
        await this.loadLib("List")
        await this.loadLib("Array")
        await this.loadLib("Buffer")
        await this.loadLib("Collection")
        await this.loadLib("Data")
        await this.loadLib("Matcher")
        await this.loadLib("Random")
        await this.loadLib("Ostap")
        await this.loadLib("STM")
        await this.loadLib("Timer")
    }

    async runModule(name, path) {
        const module = await this.loadModule(path, this.runtime)
        module.instance.exports.main()
        this.runtime[name] = module.instance.exports
    }

    async loadLib(name) {
        const module = await this.loadModule(this.stdlib_path + `/${name}.wasm`, this.runtime)
        module.instance.exports.main()
        this.runtime[name] = module.instance.exports
    }

    internalizeString(str) {
        const memory = this.runtime.Std._memory
        const reqPages = Math.floor(str.length / 65536) + 1
        const gotPages = Math.floor(memory.buffer.byteLength / 65536)
        memory.grow(reqPages - gotPages)
        const encoder = new TextEncoder()
        encoder.encodeInto(str, new Uint8Array(memory.buffer))
        return this.runtime.Std.string_from_memory(str.length)
    }

    externalizeString(pointer) {
        const len = this.runtime.Std.string_to_memory(pointer)
        const memory = this.runtime.Std._memory
        const view = new DataView(memory.buffer, 0, len)
        const decoder = new TextDecoder()
        return decoder.decode(view)
    }

    externalizeClosure(pointer) {
        const len = this.runtime.Std.closure_to_table(pointer)
        const table = this.runtime.Std._table
        const result = []

        for (let i = 0; i < len; i++) {
            result.push(table.get(i))
        }

        return result
    }

    externalizeArray(pointer) {
        const len = this.runtime.Std.array_to_table(pointer)
        const table = this.runtime.Std._table
        const result = []

        for (let i = 0; i < len; i++) {
            result.push(table.get(i))
        }

        return result
    }

    externalizeSexp(pointer) {
        const tag = de_hash(this.runtime.Std.sexp_to_tag(pointer))
        const len = this.runtime.Std.sexp_to_table(pointer)
        const table = this.runtime.Std._table
        const result = []

        for (let i = 0; i < len; i++) {
            result.push(table.get(i))
        }

        return [tag, result]
    }

    basePrintf(args) {
        const formatString = this.externalizeString(args.shift())
        for (let i = 0; i < args.length; i++) {
            if (this.runtime.Std.is_string(args[i])) {
                args[i] = this.externalizeString(args[i])
            }
        }
        return PRINTJ.sprintf(formatString, ...args)
    }
}
