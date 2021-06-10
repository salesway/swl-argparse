/*
  Different ways ;

   - flag : counts the number of times a flag was seen. 0 is always the default.
   - param : oneof looks at '=' or looks at the next argument
   - sub : launches the parsing into another context. May have a "trigger" which can be
        anything (- or not)
        the sub parser returns on the first argument it won't process
   - arg : positional argument. Must come in order. Argument cannot start with a '-'
      arg actually behaves like param and should share stuff with it...
   - trailing : gobbles up whatever it can read that is not an param
   - repeat : repeats a sub parser
   - value : sets a value on the resulting object

   expect should always match when it gets to it otherwise it fails the match.
*/


type unionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type total_result<H extends (Handler<any, any> | CliParser<any>)[]> =
  unionToIntersection<{
    [n in keyof H]:
      H[n] extends Handler<infer K, infer R> ? {[k in K]: R}
      : H[n] extends CliParser<infer Res> ? Res
      : never
  }[number]>

type optType<O> = O extends CliParser<infer V> ? V : never

export const NoMatch = Symbol('nomatch')
export const StopMatching = Symbol('stopmatching')


// the handler starts by collecting all the strings it needs to perform its changes
// once all the arguments are reparted to their respective handlers, they are then asked
// to provide a value or an error.

// The MatchError stops the parsing of the current paramParser
export class MatchError {
  constructor(public message: string) { }
}

/**
 * A Handler is asked to scan the input at a given position and returns
 *  - the elements it will consume, or
 *  - nothing, in which case the next handler will be asked for content, or
 *  - a match error
 */
export class Handler<K extends string, T> {

  constructor(
    public scan: (args: string[], pos: number, acc: string[][]) => string[] | undefined | MatchError,
    public value: (strs: string[][]) => T | MatchError,
    public opts: {
      key: K,
      help?: string
      group?: string
      activators?: string[]
    }
  ) { }

  help(help: string) { this.opts.help = help; return this }
  group(group: string) { this.opts.group = group; return this }

  derive<U>(value?: Handler<K, U>["value"], scan?: this["scan"]): Handler<K, U> {
    return new Handler(
      scan ?? this.scan,
      value as any ?? this.value,
      this.opts
    )
  }

  required() {
    return this.derive(
      (strs) => {
        let res = this.value(strs)
        if (res instanceof MatchError) return res
        if (res == null) return new MatchError(`"${this.opts.activators ?? this.opts.key}" must be specified`)
        return res as NonNullable<T>
      }
    )
  }

  map<U>(fn: (a: NonNullable<T>) => U) {
    return this.derive<undefined extends T ? U | undefined : U>(
      (strs) => {
        let res = this.value(strs)
        if (res == null) return undefined as any
        if (res instanceof MatchError) return res
        return fn(res as NonNullable<T>)
      }
    )
  }

  default(v: NonNullable<T>) {
    return this.derive<NonNullable<T>>(
      strs => {
        let res = this.value(strs)
        if (res == null) return v
        return res as NonNullable<T>
      }
    )
  }

  repeat() {
    return this.derive<NonNullable<T>[]>(
      (strs) => {
        let res: NonNullable<T>[] = []
        for (let s of strs) {
          let sres = this.value([s])
          if (sres == null) continue
          if (sres instanceof MatchError) return sres
          res.push(sres!)
        }
        return res
      },
      (args, pos) => {
        let r = this.scan(args, pos, [])
        if (r instanceof MatchError || r === undefined) return r
        return r
      },
    )
  }
}

export function flag(...activators: string[]) {
  return {
    as<K extends string>(key: K) {
      if (activators.length === 0) activators = ["--" + key]
      return new Handler(
        function (args, pos) {
          let arg = args[pos]
          if (activators.includes(args[pos]))
            return [arg]
          return undefined
        },
        function (id) {
          if (id.length > 1) return new MatchError(`"${activators}" can only appear once`)
          return !!id.length
        },
        { key, activators }
      )
    }
  }
}

export function param(...activators: string[]) {
  return {
    as<K extends string>(key: K) {
      if (activators.length === 0) activators = ["--" + key]
      return new Handler(
        function (args, pos) {
          let arg = args[pos]
          let next = args[pos + 1]
          if (activators.includes(arg)) {
            return args.slice(pos, next == undefined || next[0] === "-" ? pos + 1 : pos + 2)
          }
          return undefined
        },
        function (args) {
          if (args.length > 1) return new MatchError(`"${activators}" can only appear once`)
          return args[0]?.[1] as string | undefined
        },
        { key, activators },
      )
    }
  }
}

export function arg<K extends string>(key: K) {
  return new Handler(
    function (args, pos, acc) {
      if (acc.length > 0 || pos > args.length - 1) return undefined
      return [args[pos]]
    },
    function (args): string | undefined {
      return args[0]?.[0]
    },
    { key },
  )
}

export function oneof<O extends CliParser<any>[]>(...opt: O) {
  return {
    as<K extends string>(key: K) {
      let wm = new WeakMap<string[], { mapres: Map<Handler<any, any>, string[][]>, opt: CliParser<any> }>()
      return new Handler(
        function (args, pos) {
          // let arg = args[pos]
          let errors: string[] = []
          for (let o of opt) {
            let try_res = o.doScan(args, pos)
            if (try_res instanceof MatchError) {
              errors.push(try_res.message)
              continue
            }
            let res = args.slice(pos, try_res.pos)
            wm.set(res, {mapres: try_res.mapres, opt: o })
            return res
          }
          return new MatchError(errors.join(", "))
        },
        function (args): optType<O[number]> | undefined | MatchError {
          if (args.length > 1) throw new Error("?!")
          if (args.length === 0) return undefined
          let opt = wm.get(args[0])
          if (!opt) return undefined // this should never happen !?
          return opt.opt.doValues(opt.mapres)
        },
        { key }
      )
    }
  }
}

export function expect<K2 extends string>(value: K2) {
  return {
    as<K extends string>(key: K) {
      return new Handler(
        function (argv, pos, acc) {
          let arg = argv[pos]
          if (acc.length > 0) return undefined
          if (arg !== value) return new MatchError(`expected "${value}"`)
          return [arg]
        },
        function () {
          return value as K2
        },
        { key }
      )
    }
  }
}

/**
 * Expand the command line to ventilate grouped singe "-" params and "=" parameters
 * of both "-" and "--" arguments.
 *
 * @param argv The original argv
 * @returns A new, simplified argv
 */
export function expand_flags(argv: string[]) {
  let res: string[] = []
  for (let arg of argv) {
    if (arg[0] === "-" && arg[1] !== "-") {
      for (let i = 1, l = arg.length; i < l; i++) {
        if (arg[i] === "=") {
          res.push(arg.slice(i + 1))
          break
        } else {
          res.push("-" + arg[i])
        }
      }
    } else if (arg[0] === "-" && arg[1] === "-" && arg.includes("=")) {
      let first = arg.search("=")
      res.push(arg.slice(0, first))
      res.push(arg.slice(first + 1))
    } else {
      res.push(arg)
    }
  }
  return res
}

///////////


export class CliParser<T = {}> {
  private handlers: Handler<any, any>[] = []
  private _prelude: string = ""
  private _epilogue: string = ""

  prelude(pre: string) { this._prelude = pre; return this }
  epilogue(epi: string) { this._epilogue = epi; return this }

  clone<U = T>(): CliParser<U> {
    let n = new CliParser<U>()
    n._prelude = this._prelude
    n._epilogue = this._epilogue
    n.handlers = this.handlers.slice()
    return n
  }

  include<U>(other: CliParser<U>) {
    let n = this.clone<T & U>()
    n.handlers.push(...other.handlers)
    return n
  }

  add_handler<H extends (Handler<any, any> | CliParser<any>)[]>(...hld: H): CliParser<T & total_result<H>> {
    let n = this.clone<T & total_result<H> >()
    for (let h of hld) {
      if (h instanceof Handler)
        n.handlers.push(h)
      else n.handlers.push(...h.handlers)
    }
    return n
  }

  show_help() {
    console.error(`Usage: this [params]`)
  }

  /** doScan returns */
  doScan(args: string[], pos: number) {
    let mapres = new Map<Handler<any, any>, string[][]>()
    for (let h of this.handlers) {
      mapres.set(h, [])
    }

    let l = args.length
    let init = pos
    scanargs: while (pos < l) {
      for (let h of this.handlers) {
        let acc = mapres.get(h)!
        let res = h.scan(args, pos, acc)
        if (res instanceof MatchError) return res
        if (res == undefined) continue
        pos += res.length
        acc.push(res)
        continue scanargs
      }

      break
    }

    if (pos === init && pos < args.length) return new MatchError("nothing was consumed")

    return {pos, mapres}
  }

  doValues(mapres: Map<Handler<any, any>, string[][]>) {
    let res: any = {}
    for (let h of this.handlers) {
      let r = h.value(mapres.get(h) ?? [])
      if (r instanceof MatchError) return r
      res[h.opts.key] = r
    }

    return res as T
  }

  parse(args: string[] = process.argv.slice(2)): T {
    args = expand_flags(args)
    let r = this.doScan(args, 0)

    if (r instanceof MatchError) throw new Error("match error: " + r.message)

    if (r.pos !== args.length) {
      console.error("unrecognized argument", `'${args[r.pos]}'`)
      this.show_help()
      process.exit(1)
    }

    let r2 = this.doValues(r.mapres)
    if (r2 instanceof MatchError) throw new Error("match error: " + r2.message)
    return r2
  }
}

export function optparser<H extends (Handler<any, any> | CliParser<any>)[]>(...h: H): CliParser<total_result<H>> {
  let o = new CliParser()
  return o.add_handler(...h)
}
