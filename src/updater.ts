// Auto-update from the GitHub Releases of will-terminal (tauri-plugin-updater), same as will-repo.
// The release workflow signs each installer; the app only accepts files signed
// with the private key that matches the public key in tauri.conf.json.
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";

/** Downloads with a progress toast, installs and restarts the app */
async function install(update: Update, beforeRestart: () => void) {
  const id = toast.loading(`Baixando a versão ${update.version}...`);
  let total = 0;
  let done = 0;
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        done += e.data.chunkLength;
        if (total) toast.loading(`Baixando a versão ${update.version}... ${Math.round((done / total) * 100)}%`, { id });
      } else toast.loading("Instalando...", { id });
    });
    beforeRestart();
    await relaunch();
  } catch (e) {
    toast.error(`Não foi possível atualizar: ${e}`, { id });
  }
}

/**
 * Looks for a newer release. `quiet`: on startup, say nothing when there is no
 * update or no internet; from the palette, always answer.
 * `beforeRestart` saves the layout: the update restarts the app, which ends the shells.
 */
export async function checkForUpdate(quiet: boolean, beforeRestart: () => void) {
  try {
    const update = await check();
    if (!update) {
      if (!quiet) toast.success("Você já está na versão mais nova");
      return;
    }
    toast.info(`Nova versão ${update.version} disponível`, {
      description: "Atualizar reinicia o app: os terminais abertos fecham e o layout volta.",
      duration: Infinity,
      action: { label: "Atualizar", onClick: () => install(update, beforeRestart) },
    });
  } catch (e) {
    if (!quiet) toast.error(`Não foi possível procurar atualizações: ${e}`);
  }
}
