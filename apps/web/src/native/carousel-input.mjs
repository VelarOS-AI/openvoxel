const minimumWheelDelta = 4;
const wheelCooldownMilliseconds = 320;

export function createCarouselWheelInput(now = () => performance.now()) {
  let lastWheelAt = Number.NEGATIVE_INFINITY;
  return (event, worldCount) => {
    if (!Number.isInteger(worldCount) || worldCount <= 1 || event.ctrlKey === true || event.metaKey === true) {
      return 0;
    }
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    const eventTime = now();
    if (!Number.isFinite(delta) || Math.abs(delta) < minimumWheelDelta || eventTime - lastWheelAt < wheelCooldownMilliseconds) {
      return 0;
    }
    lastWheelAt = eventTime;
    event.preventDefault();
    return delta > 0 ? 1 : -1;
  };
}
