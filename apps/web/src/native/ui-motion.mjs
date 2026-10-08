// Menu state changes commit immediately. Only compositor-friendly opacity/transform animate.
let releaseMenuEffect = () => {};
const panelAnimations = new WeakMap();
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export function transitionMenu(update) {
  releaseMenuEffect();
  const oldImage = document.querySelector('[data-world-background], [data-preset-background]');
  const oldSource = oldImage?.currentSrc || oldImage?.src;
  update();
  if (reducedMotion() || document.hidden) return null;

  let cancelled = false;
  let overlay = null;
  let observer = null;
  let timeout = null;
  let frameId = null;
  const animations = [];
  const release = () => {
    cancelled = true;
    observer?.disconnect();
    clearTimeout(timeout);
    if (frameId !== null) cancelAnimationFrame(frameId);
    overlay?.remove();
    for (const animation of animations) animation.cancel();
  };
  releaseMenuEffect = release;
  const animate = () => {
    observer?.disconnect();
    clearTimeout(timeout);
    if (cancelled) return;
    const image = document.querySelector('[data-world-background], [data-preset-background]');
    if (image && oldSource && image.src !== oldSource) {
      overlay = oldImage.cloneNode(false);
      overlay.src = oldSource;
      overlay.removeAttribute('data-world-background');
      overlay.removeAttribute('data-preset-background');
      overlay.setAttribute('data-cover-transition', '');
      overlay.style.pointerEvents = 'none';
      image.after(overlay);
      // Decoding never blocks the action or the incoming UI. The outgoing image fades away.
      let fading = false;
      const fadeCover = () => {
        if (cancelled || fading || !overlay?.isConnected) return;
        fading = true;
        clearTimeout(timeout);
        const cover = overlay;
        const animation = cover.animate([{opacity: 1}, {opacity: 0}], {duration: 280, easing: 'ease-out', fill: 'forwards'});
        animations.push(animation);
        animation.finished.then(() => cover.remove(), () => {});
      };
      timeout = setTimeout(fadeCover, 350);
      image.decode().then(fadeCover, fadeCover);
    }
    for (const element of document.querySelectorAll('[data-world-carousel] > :first-child, [data-empty-worlds], [data-create-world-form], [data-open-world-form]')) {
      animations.push(element.animate([
        {opacity: .55, transform: 'translateY(5px)'},
        {opacity: 1, transform: 'translateY(0)'},
      ], {duration: 180, easing: 'ease-out'}));
    }
  };
  frameId = requestAnimationFrame(() => {
    if (cancelled) return;
    if (!document.querySelector('[data-route-module-loading]')) { animate(); return; }
    // Lazy routes can mount later, while navigation and all input remain responsive.
    observer = new MutationObserver(() => {
      if (!document.querySelector('[data-route-module-loading]')) animate();
    });
    observer.observe(document.getElementById('app'), {childList: true, subtree: true});
    timeout = setTimeout(() => observer.disconnect(), 2000);
  });
  return null;
}

export function transitionPanel(element, update) {
  update();
  if (!element || reducedMotion()) return null;
  panelAnimations.get(element)?.cancel();
  requestAnimationFrame(() => {
    if (!element.isConnected) return;
    const animation = element.animate([
      {opacity: 0.6, transform: 'translateY(4px)'},
      {opacity: 1, transform: 'translateY(0)'},
    ], {duration: 160, easing: 'ease-out'});
    panelAnimations.set(element, animation);
  });
  return null;
}
