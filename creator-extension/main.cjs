const { createLauncher } = require("./launcher.cjs");
let launcher;

exports.load = function () {
    launcher = createLauncher({ editor: Editor });
};
exports.unload = function () {
    // The inspector owns its runtime; reloading an editor extension should
    // preserve the user's current game and debugging state.
    launcher = undefined;
};
exports.methods = {
    async openInspector() {
        try {
            if (!launcher) launcher = createLauncher({ editor: Editor });
            return await launcher.open();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[Cocos Live Probe]", message);
            await Editor.Dialog.error(message, { title: "Cocos Live Probe 启动失败" });
            return { error: message };
        }
    },
};
