import { deadlineTransport, observePage, PageIdentity, PageTransport } from "./runtime-interaction";

export interface RenderCommand { kind: "render-ready"; timeoutMs: number }
export function renderTimeout(value: unknown): number {
    const timeout = value ?? 5000;
    if (!Number.isInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 10000) throw new Error("Render timeoutMs must be 1..10000");
    return Number(timeout);
}

// Runs in the preview. Only the public after-draw event establishes rendering.
export async function readRenderState(waitMs: number, refreshGeneration = 0): Promise<any> {
    const g = globalThis as any;
    let cc = g.cc;
    try {
        if (g.System?.resolve && g.System?.get) cc = g.System.get(await g.System.resolve("cc"));
        else if (g.System?.import) cc = await g.System.import("cc");
    } catch { return { status: "unsupported", engineReady: false }; }
    const director = cc?.director;
    const scene = director?.getScene?.();
    const key = "__cocosLiveProbeRenderEvidence";
    if (g[key] && g[key].director !== director) { g[key].dispose?.(); delete g[key]; }
    if (!g[key]) Object.defineProperty(g, key, { configurable: true, value: { scenes: new WeakMap(), confirmed: null, scene, epoch: 0, director, refreshGeneration } });
    const cache = g[key];
    if (cache.refreshGeneration !== refreshGeneration) { cache.refreshGeneration = refreshGeneration; cache.confirmed = null; cache.epoch++; }
    if (cache.scene !== scene) { cache.scene = scene; cache.confirmed = null; cache.epoch++; }
    if (!cache.invalidate && director?.on && director?.off && cc?.Director?.EVENT_BEFORE_SCENE_LAUNCH) {
        cache.invalidate = () => { cache.confirmed = null; cache.epoch++; };
        director.on(cc.Director.EVENT_BEFORE_SCENE_LAUNCH, cache.invalidate);
        cache.dispose = () => { director.off(cc.Director.EVENT_BEFORE_SCENE_LAUNCH, cache.invalidate); cache.cancel?.(); delete g[key]; };
    }
    if (scene && !cache.scenes.has(scene)) cache.scenes.set(scene, g.crypto.randomUUID());
    const sceneId = scene ? cache.scenes.get(scene) : null;
    const base = { engineReady: Boolean(scene), sceneId, scene: scene?.name ?? null, observedAt: new Date().toISOString(),
        frameSource: "Cocos Director after-draw; observation begins after connection, not game startup" };
    if (cache.confirmed?.sceneId === sceneId && sceneId && (cache.invalidate || typeof director?.getTotalFrames === "function" && director.getTotalFrames() === cache.confirmed.frame)) return { ...base, ...cache.confirmed, status: "rendered", cached: true };
    const event = cc?.Director?.EVENT_AFTER_DRAW;
    if (!scene || !event || !director.on || !director.off) return { ...base, status: "unsupported" };
    if (cc.game?.isPaused?.() || director.isPaused?.()) return { ...base, status: "paused-unverified" };
    if (!waitMs) return { ...base, status: "unverified" };
    const epoch = cache.epoch;
    return new Promise(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const complete = (result: any) => { clearTimeout(timer); try { director.off(event, drawn); } catch { /* An incompatible engine cannot retain valid evidence. */ } cache.cancel = undefined; resolve(result); };
        const drawn = () => {
            if (director.getScene() !== scene || cache.epoch !== epoch) { complete({ ...base, status: "page-changed" }); return; }
            cache.confirmed = { sceneId, confirmedAt: new Date().toISOString(), ...(typeof director.getTotalFrames === "function"
                ? { frame: director.getTotalFrames(), frameSource: "Cocos Director total frames; not document or simulation steps" } : {}) };
            complete({ ...base, ...cache.confirmed, status: "rendered", cached: false });
        };
        cache.cancel = () => complete({ ...base, status: "page-changed" });
        timer = setTimeout(() => complete({ ...base, status: "timeout" }), waitMs);
        try { director.on(event, drawn); } catch { complete({ ...base, status: "unsupported" }); }
    });
}

export async function waitForRender(page: PageTransport, identity: PageIdentity, deadline: number, validate: (ms: number) => Promise<unknown>) {
    const bounded = deadlineTransport(page, deadline);
    const initial = await observePage(bounded, identity);
    await validate(Math.max(1, deadline - performance.now()));
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 1) return { status: "timeout", engineReady: Boolean(initial.cocos.scene), observation: initial.observation };
    const result = await bounded.evaluate(`(${readRenderState.toString()})(${Math.max(1, remaining - 20)},${identity.refreshGeneration})`) as any;
    if (performance.now() >= deadline) return { ...result, status: "timeout", observation: initial.observation };
    const latest = await observePage(bounded, identity);
    if (latest.observation.documentId !== initial.observation.documentId) return { ...result, status: "page-changed", observation: latest.observation };
    if (result.status === "rendered") {
        const current = await bounded.evaluate(`(${readRenderState.toString()})(0,${identity.refreshGeneration})`) as any;
        if (current.status !== "rendered" || current.sceneId !== result.sceneId || current.confirmedAt !== result.confirmedAt) return { ...result, status: "page-changed", observation: latest.observation };
    }
    return { ...result, observation: latest.observation };
}
