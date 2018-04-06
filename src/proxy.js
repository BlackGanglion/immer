"use strict"
// @ts-check

/**
 * 主要思路就是对于数组/对象在访问时进行逐层 proxy 化，假如有设置新的值，将新值设置到 copy 中，并对所有父级完成同样的操作
 * base（原始）-> proxies(数组/对象键值 proxy化) -> copy 修改后的值
 */

import {
    is,
    has,
    isProxyable,
    isProxy,
    PROXY_STATE,
    finalize,
    shallowCopy,
    RETURNED_AND_MODIFIED_ERROR,
    each
} from "./common"

// 全局
let proxies = null

const objectTraps = {
    get,
    has(target, prop) {
        return prop in source(target)
    },
    // Object.getOwnPropertyNames(proxy)
    // Object.getOwnPropertySymbols(proxy)
    // Object.keys(proxy)
    ownKeys(target) {
        return Reflect.ownKeys(source(target))
    },
    set,
    deleteProperty,
    // 返回指定对象上一个自有属性对应的属性描述符
    getOwnPropertyDescriptor,
    defineProperty,
    setPrototypeOf() {
        throw new Error("Don't even try this...")
    }
}

const arrayTraps = {}
each(objectTraps, (key, fn) => {
    arrayTraps[key] = function() {
        arguments[0] = arguments[0][0]
        return fn.apply(this, arguments)
    }
})

function createState(parent, base) {
    return {
        // 是否被修改
        modified: false,
        // 是否已完成
        finalized: false,
        // 父级对象
        parent,
        // 原始对象
        base,
        // 拷贝元素，合并自 base 与 proxies，modified = true 后存在，防止 base 被篡改，set 生成
        copy: undefined,
        // 存储 key 对应 array、object 的 proxy，相当于是 base 的 proxy 化，get 生成
        proxies: {}
    }
}

function source(state) {
    // 如果已被修改，使用 copy，不然使用 base
    return state.modified === true ? state.copy : state.base
}

// state 为目标对象，prop 为对象的属性名
// set 之前必先 get
// 访问时会逐层访问，所以注意一下父子嵌套的情况
function get(state, prop) {
    // 返回整个 state
    if (prop === PROXY_STATE) return state
    // 已被修改
    if (state.modified) {
        const value = state.copy[prop]
        if (value === state.base[prop] && isProxyable(value))
            // only create proxy if it is not yet a proxy, and not a new object
            // (new objects don't need proxying, they will be processed in finalize anyway)
            return (state.copy[prop] = createProxy(state, value))
        return value
    } else {
        if (has(state.proxies, prop)) return state.proxies[prop]
        const value = state.base[prop]
        if (!isProxy(value) && isProxyable(value))
            // 存储每个 propertyKey 的代理对象，采用懒初始化策略    
            return (state.proxies[prop] = createProxy(state, value))
        return value
    }
}

function set(state, prop, value) {
    if (!state.modified) {
        // 值相同，直接返回
        if (
            (prop in state.base && is(state.base[prop], value)) ||
            (has(state.proxies, prop) && state.proxies[prop] === value)
        )
            return true
        // 否则执行修改，然后修改 copy 中的数据，也会更新父级
        markChanged(state)
    }
    state.copy[prop] = value
    return true
}

function deleteProperty(state, prop) {
    markChanged(state)
    delete state.copy[prop]
    return true
}

function getOwnPropertyDescriptor(state, prop) {
    const owner = state.modified
        ? state.copy
        : has(state.proxies, prop) ? state.proxies : state.base
    const descriptor = Reflect.getOwnPropertyDescriptor(owner, prop)
    if (descriptor && !(Array.isArray(owner) && prop === "length"))
        descriptor.configurable = true
    return descriptor
}

function defineProperty() {
    throw new Error(
        "Immer does currently not support defining properties on draft objects"
    )
}

function markChanged(state) {
    if (!state.modified) {
        state.modified = true
        state.copy = shallowCopy(state.base)
        // copy the proxies over the base-copy
        Object.assign(state.copy, state.proxies) // yup that works for arrays as well
        // 存在父级，父级也需要更新
        if (state.parent) markChanged(state.parent)
    }
}

// creates a proxy for plain objects / arrays
function createProxy(parentState, base) {
    const state = createState(parentState, base)
    // 数组和 object 分开处理
    const proxy = Array.isArray(base)
        // Proxy.revocable 返回 { proxy(实例), revoke(取消实例，再访问就会抛出错误) }
        ? Proxy.revocable([state], arrayTraps)
        : Proxy.revocable(state, objectTraps)
    proxies.push(proxy)
    return proxy.proxy
}

export function produceProxy(baseState, producer) {
    const previousProxies = proxies
    proxies = []
    try {
        // create proxy for root
        const rootProxy = createProxy(undefined, baseState)
        // execute the thunk
        const returnValue = producer.call(rootProxy, rootProxy)
        // and finalize the modified proxy
        let result
        // check whether the draft was modified and/or a value was returned
        if (returnValue !== undefined && returnValue !== rootProxy) {
            // something was returned, and it wasn't the proxy itself
            if (rootProxy[PROXY_STATE].modified)
                throw new Error(RETURNED_AND_MODIFIED_ERROR)

            // See #117
            // Should we just throw when returning a proxy which is not the root, but a subset of the original state?
            // Looks like a wrongly modeled reducer
            result = finalize(returnValue)
        } else {
            result = finalize(rootProxy)
        }
        // revoke all proxies
        each(proxies, (_, p) => p.revoke())
        return result
    } finally {
        proxies = previousProxies
    }
}
