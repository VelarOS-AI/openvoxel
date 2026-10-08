import {join} from "node:path";
import {fileURLToPath} from "node:url";

export const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const velarCli = join(projectRoot, "node_modules", "@velarscript", "cli", "dist", "cli.js");
export const screenshotsDirectory = join(projectRoot, "apps", "web", "generated", "ui-acceptance");
export const webDistDirectory = join(projectRoot, "apps", "web", "dist");
export const builtHtmlPath = join(webDistDirectory, "index.html");
export const builtManifestPath = join(webDistDirectory, "velar-build.json");
