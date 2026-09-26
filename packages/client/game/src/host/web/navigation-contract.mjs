export const orbitMode = "orbit";
export const firstPersonMode = "first-person";
export const creativeFlightMovement = "creative-flight";
export const survivalWalkMovement = "survival-walk";

export function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value;
}

export function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

export function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}

export function requireMode(value) {
  if (value !== orbitMode && value !== firstPersonMode) {
    throw new RangeError(`Voxel navigation mode must be ${orbitMode} or ${firstPersonMode}`);
  }
  return value;
}

export function requireMovementMode(value) {
  if (value !== creativeFlightMovement && value !== survivalWalkMovement) {
    throw new RangeError(`Voxel movement mode must be ${creativeFlightMovement} or ${survivalWalkMovement}`);
  }
  return value;
}

export function requirePosition(value, label) {
  value = requireRecord(value, label);
  return {
    x: requireFinite(value.x, `${label} x`),
    y: requireFinite(value.y, `${label} y`),
    z: requireFinite(value.z, `${label} z`),
  };
}

export function requireFlightState(value) {
  value = requireRecord(value, "Creative flight state");
  return {
    x: requireFinite(value.x, "Creative flight state x"),
    y: requireFinite(value.y, "Creative flight state y"),
    z: requireFinite(value.z, "Creative flight state z"),
    velocityX: requireFinite(value.velocityX, "Creative flight state velocityX"),
    velocityY: requireFinite(value.velocityY, "Creative flight state velocityY"),
    velocityZ: requireFinite(value.velocityZ, "Creative flight state velocityZ"),
  };
}

export function requireSurvivalState(value) {
  value = requireRecord(value, "Survival walk state");
  return {
    x: requireFinite(value.x, "Survival walk state x"),
    y: requireFinite(value.y, "Survival walk state y"),
    z: requireFinite(value.z, "Survival walk state z"),
    velocityX: requireFinite(value.velocityX, "Survival walk state velocityX"),
    velocityY: requireFinite(value.velocityY, "Survival walk state velocityY"),
    velocityZ: requireFinite(value.velocityZ, "Survival walk state velocityZ"),
    grounded: value.grounded === true,
    crouching: value.crouching === true,
  };
}

export function requireBasis(value) {
  value = requireRecord(value, "First-person movement basis");
  return {
    forwardX: requireFinite(value.forwardX, "Creative flight basis forwardX"),
    forwardZ: requireFinite(value.forwardZ, "Creative flight basis forwardZ"),
    rightX: requireFinite(value.rightX, "Creative flight basis rightX"),
    rightZ: requireFinite(value.rightZ, "Creative flight basis rightZ"),
  };
}

export function requireDirection(value) {
  value = requirePosition(value, "Voxel navigation view direction");
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= 0.000001) throw new RangeError("Voxel navigation view direction must be non-zero");
  return {x: value.x / length, y: value.y / length, z: value.z / length};
}

export function requireBounds(value) {
  value = requireRecord(value, "Voxel movement bounds");
  const minimumY = requireFinite(value.minimumY, "Voxel movement minimum y");
  const maximumY = requireFinite(value.maximumY, "Voxel movement maximum y");
  if (minimumY >= maximumY) throw new RangeError("Voxel movement y bounds are inverted");
  return {minimumY, maximumY};
}

export function chunkCoordinate(value, edge) {
  return Math.floor(value / edge);
}
