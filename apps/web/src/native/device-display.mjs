let active = false;
let ownedFullscreen = false;
let ownedOrientation = false;
let fullscreenRequest = null;
let orientationRequest = null;
const ignoreUnsupported = () => {};

function unlockOrientation() {
  if (!ownedOrientation) return;
  ownedOrientation = false;
  try { globalThis.screen?.orientation?.unlock?.(); } catch { /* This browser no longer has a lock. */ }
}

function exitOwnedFullscreen() {
  if (!ownedFullscreen) return;
  ownedFullscreen = false;
  if (document.fullscreenElement === document.documentElement) {
    try { Promise.resolve(document.exitFullscreen()).catch(ignoreUnsupported); } catch { /* Already exited. */ }
  }
}

function lockLandscape() {
  if (!active || orientationRequest || !globalThis.screen?.orientation?.lock) return;
  try {
    orientationRequest = Promise.resolve(screen.orientation.lock('landscape')).then(() => {
      orientationRequest = null;
      ownedOrientation = true;
      if (!active) unlockOrientation();
    }, () => { orientationRequest = null; });
  } catch { /* Portrait guidance remains available when orientation lock is unsupported. */ }
}

export function requestGameLandscape() {
  if (!globalThis.matchMedia?.('(pointer: coarse)').matches) return null;
  active = true;
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) lockLandscape();
  else if (!fullscreenRequest) {
    try {
      fullscreenRequest = Promise.resolve(document.documentElement.requestFullscreen()).then(() => {
        fullscreenRequest = null;
        ownedFullscreen = document.fullscreenElement === document.documentElement;
        if (active) lockLandscape();
        else exitOwnedFullscreen();
      }, () => { fullscreenRequest = null; lockLandscape(); });
    } catch { lockLandscape(); }
  }
  return null;
}

export function releaseGameLandscape() {
  active = false;
  unlockOrientation();
  exitOwnedFullscreen();
  return null;
}
