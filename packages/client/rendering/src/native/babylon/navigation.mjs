const orbitMode = "orbit";
const firstPersonMode = "first-person";
const creativeFlightMovement = "creative-flight";
const survivalWalkMovement = "survival-walk";
const navigationOwnerByCanvas = new WeakMap();
const mouseSensitivity = 0.0021;
const maximumPointerDelta = 500;
const viewDirectionCosineThreshold = 0.9914448613738104;
const firstPersonControlCodes = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyC",
  "Space",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
]);

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value;
}

function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}

function requireMode(value) {
  if (value !== orbitMode && value !== firstPersonMode) {
    throw new RangeError(`Voxel navigation mode must be ${orbitMode} or ${firstPersonMode}`);
  }
  return value;
}

function requireMovementMode(value) {
  if (value !== creativeFlightMovement && value !== survivalWalkMovement) {
    throw new RangeError(`Voxel movement mode must be ${creativeFlightMovement} or ${survivalWalkMovement}`);
  }
  return value;
}

function requirePosition(value, label) {
  value = requireRecord(value, label);
  return {
    x: requireFinite(value.x, `${label} x`),
    y: requireFinite(value.y, `${label} y`),
    z: requireFinite(value.z, `${label} z`),
  };
}

function requireFlightState(value) {
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

function requireSurvivalState(value) {
  value = requireRecord(value, "Survival walk state");
  return {
    x: requireFinite(value.x, "Survival walk state x"),
    y: requireFinite(value.y, "Survival walk state y"),
    z: requireFinite(value.z, "Survival walk state z"),
    velocityX: requireFinite(value.velocityX, "Survival walk state velocityX"),
    velocityY: requireFinite(value.velocityY, "Survival walk state velocityY"),
    velocityZ: requireFinite(value.velocityZ, "Survival walk state velocityZ"),
    grounded: value.grounded === true,
  };
}

function requireBasis(value) {
  value = requireRecord(value, "First-person movement basis");
  return {
    forwardX: requireFinite(value.forwardX, "Creative flight basis forwardX"),
    forwardZ: requireFinite(value.forwardZ, "Creative flight basis forwardZ"),
    rightX: requireFinite(value.rightX, "Creative flight basis rightX"),
    rightZ: requireFinite(value.rightZ, "Creative flight basis rightZ"),
  };
}

function requireDirection(value) {
  value = requirePosition(value, "Voxel navigation view direction");
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= 0.000001) throw new RangeError("Voxel navigation view direction must be non-zero");
  return {x: value.x / length, y: value.y / length, z: value.z / length};
}

function requireBounds(value) {
  value = requireRecord(value, "Voxel movement bounds");
  const minimumY = requireFinite(value.minimumY, "Voxel movement minimum y");
  const maximumY = requireFinite(value.maximumY, "Voxel movement maximum y");
  if (minimumY >= maximumY) throw new RangeError("Voxel movement y bounds are inverted");
  return {minimumY, maximumY};
}

function clampPointerDelta(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-maximumPointerDelta, Math.min(maximumPointerDelta, value));
}

function chunkCoordinate(value, edge) {
  return Math.floor(value / edge);
}

class BabylonVoxelNavigation {
  constructor(options) {
    options = requireRecord(options, "Voxel navigation options");
    this.canvas = options.canvas;
    if (!(this.canvas instanceof globalThis.HTMLCanvasElement)) {
      throw new TypeError("Voxel navigation requires a canvas element");
    }
    this.mode = requireMode(options.mode);
    this.movementMode = requireMovementMode(options.movementMode);
    this.edge = requireFinite(options.edge, "Voxel navigation Chunk edge");
    if (!Number.isSafeInteger(this.edge) || this.edge < 1) {
      throw new RangeError("Voxel navigation Chunk edge must be a positive integer");
    }
    this.bounds = requireBounds(options.bounds);
    this.flightState = requireFlightState(options.initialState);
    this.survivalState = requireSurvivalState(options.initialSurvivalState);
    this.stepCreativeFlight = requireFunction(options.stepCreativeFlight, "Voxel navigation creative flight step");
    this.stepSurvivalWalk = requireFunction(options.stepSurvivalWalk, "Voxel navigation survival walk step");
    this.collisionAt = requireFunction(options.collisionAt, "Voxel navigation collision query");
    this.readViewPosition = requireFunction(options.readViewPosition, "Voxel navigation view position reader");
    this.readViewForward = requireFunction(options.readViewForward, "Voxel navigation view direction reader");
    this.readHorizontalBasis = requireFunction(options.readHorizontalBasis, "Voxel navigation basis reader");
    this.applyFlightState = requireFunction(options.applyFlightState, "Voxel navigation flight state writer");
    this.applySurvivalState = requireFunction(options.applySurvivalState, "Voxel navigation survival state writer");
    this.rotateView = requireFunction(options.rotateView, "Voxel navigation view rotation writer");
    this.releaseView = requireFunction(options.releaseView, "Voxel navigation view release");
    this.viewChanged = requireFunction(options.viewChanged, "Voxel navigation viewChanged");
    this.document = this.canvas.ownerDocument;
    this.window = this.document.defaultView;
    if (this.window === null) throw new Error("Voxel navigation canvas is not attached to a browser Window");
    this.keys = new Set();
    this.owner = {};
    navigationOwnerByCanvas.set(this.canvas, this.owner);
    this.released = false;
    this.pointerLocked = false;
    this.pointerLockRequest = null;
    const initial = this.viewPosition();
    this.lastViewCenterX = chunkCoordinate(initial.x, this.edge);
    this.lastViewCenterY = chunkCoordinate(initial.y, this.edge);
    this.lastViewCenterZ = chunkCoordinate(initial.z, this.edge);
    this.lastViewForward = requireDirection(this.readViewForward());
    this.onPointerDown = (event) => this.capturePointer(event);
    this.onPointerLockChange = () => this.synchronizePointerLock();
    this.onPointerLockError = () => {
      const ownership = this.pointerLockRequest;
      if (ownership !== null) this.rejectPointerCapture(ownership);
    };
    this.onMouseMove = (event) => this.look(event);
    this.onKeyDown = (event) => this.press(event);
    this.onKeyUp = (event) => this.releaseKey(event);
    this.clearMotion = () => {
      this.keys.clear();
      if (this.mode !== firstPersonMode) return;
      if (this.movementMode === creativeFlightMovement) {
        this.flightState = {
          x: this.flightState.x,
          y: this.flightState.y,
          z: this.flightState.z,
          velocityX: 0,
          velocityY: 0,
          velocityZ: 0,
        };
        this.applyFlightState(this.flightState);
      } else {
        this.survivalState = {
          ...this.survivalState,
          velocityX: 0,
          velocityZ: 0,
        };
        this.applySurvivalState(this.survivalState);
      }
    };
    this.onVisibilityChange = () => {
      if (this.document.visibilityState !== "visible") this.clearMotion();
    };
    this.canvas.setAttribute("data-navigation-mode", this.mode);
    this.canvas.setAttribute("data-movement-mode", this.movementMode);
    this.canvas.setAttribute("data-pointer-locked", "false");
    this.writePlayerStateAttributes(initial);
    this.writeViewChunkAttributes();
    if (this.mode === firstPersonMode) {
      this.attachFirstPersonControls();
      this.synchronizePointerLock();
    }
  }

  ownsCanvas() {
    return navigationOwnerByCanvas.get(this.canvas) === this.owner;
  }

  attachFirstPersonControls() {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.document.addEventListener("pointerlockchange", this.onPointerLockChange);
    this.document.addEventListener("pointerlockerror", this.onPointerLockError);
    this.document.addEventListener("mousemove", this.onMouseMove);
    this.window.addEventListener("keydown", this.onKeyDown);
    this.window.addEventListener("keyup", this.onKeyUp);
    this.window.addEventListener("blur", this.clearMotion);
    this.canvas.addEventListener("blur", this.clearMotion);
    this.document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  detachFirstPersonInput() {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.document.removeEventListener("mousemove", this.onMouseMove);
    this.window.removeEventListener("keydown", this.onKeyDown);
    this.window.removeEventListener("keyup", this.onKeyUp);
    this.window.removeEventListener("blur", this.clearMotion);
    this.canvas.removeEventListener("blur", this.clearMotion);
    this.document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  detachPointerLockLifecycle() {
    this.document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.document.removeEventListener("pointerlockerror", this.onPointerLockError);
  }

  finishReleasedPointerLockLifecycle() {
    if (!this.released) return;
    if (!this.ownsCanvas()) {
      this.detachPointerLockLifecycle();
      return;
    }
    if (this.pointerLockRequest !== null || this.document.pointerLockElement === this.canvas) return;
    this.detachPointerLockLifecycle();
    navigationOwnerByCanvas.delete(this.canvas);
  }

  firstPersonInputActive() {
    return this.pointerLocked
      || (typeof this.canvas.requestPointerLock !== "function" && this.document.activeElement === this.canvas);
  }

  capturePointer(event) {
    if (this.released || !this.ownsCanvas() || event.button !== 0) return;
    this.canvas.focus({preventScroll: true});
    if (
      this.document.pointerLockElement === this.canvas
      || this.pointerLockRequest !== null
      || typeof this.canvas.requestPointerLock !== "function"
    ) return;
    const ownership = {};
    this.pointerLockRequest = ownership;
    try {
      const request = this.canvas.requestPointerLock();
      if (request !== undefined && typeof request.then === "function") {
        Promise.resolve(request).then(
          () => this.completePointerCapture(ownership),
          () => this.rejectPointerCapture(ownership),
        );
      }
    } catch {
      this.rejectPointerCapture(ownership);
    }
  }

  completePointerCapture(ownership) {
    const ownsRequest = this.pointerLockRequest === ownership;
    if (ownsRequest) this.pointerLockRequest = null;
    if (!ownsRequest) return;
    if (this.released) {
      this.exitReleasedPointerLock();
      this.finishReleasedPointerLockLifecycle();
      return;
    }
    if (!this.ownsCanvas()) return;
    this.synchronizePointerLock();
  }

  rejectPointerCapture(ownership) {
    if (this.pointerLockRequest !== ownership) return;
    this.pointerLockRequest = null;
    if (this.released) {
      this.finishReleasedPointerLockLifecycle();
      return;
    }
    if (this.ownsCanvas()) this.clearMotion();
  }

  exitOwnedPointerLock() {
    this.exitPointerLockWhenOwned(false);
  }

  exitReleasedPointerLock() {
    this.exitPointerLockWhenOwned(true);
  }

  exitPointerLockWhenOwned(allowUnowned) {
    const currentOwner = navigationOwnerByCanvas.get(this.canvas);
    if (
      (currentOwner === this.owner || (allowUnowned && currentOwner === undefined))
      &&
      this.document.pointerLockElement === this.canvas
      && typeof this.document.exitPointerLock === "function"
    ) this.document.exitPointerLock();
  }

  synchronizePointerLock() {
    if (!this.ownsCanvas()) {
      this.pointerLocked = false;
      this.finishReleasedPointerLockLifecycle();
      return;
    }
    const acquired = this.document.pointerLockElement === this.canvas;
    if (acquired) this.pointerLockRequest = null;
    this.pointerLocked = !this.released && acquired;
    this.canvas.setAttribute("data-pointer-locked", String(this.pointerLocked));
    if (!this.pointerLocked) this.clearMotion();
    if (this.released && acquired) this.exitReleasedPointerLock();
    this.finishReleasedPointerLockLifecycle();
  }

  look(event) {
    if (this.released || !this.ownsCanvas() || !this.pointerLocked) return;
    this.rotateView(
      clampPointerDelta(event.movementX) * mouseSensitivity,
      clampPointerDelta(event.movementY) * mouseSensitivity,
    );
  }

  press(event) {
    if (this.released || !this.ownsCanvas() || !firstPersonControlCodes.has(event.code) || !this.firstPersonInputActive()) return;
    event.preventDefault();
    this.keys.add(event.code);
  }

  releaseKey(event) {
    if (!firstPersonControlCodes.has(event.code)) return;
    if (this.ownsCanvas() && this.firstPersonInputActive()) event.preventDefault();
    this.keys.delete(event.code);
  }

  update(deltaMilliseconds) {
    if (this.released || !this.ownsCanvas()) return;
    if (this.mode === firstPersonMode && this.movementMode === creativeFlightMovement) {
      const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const sideways = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      const descending = this.keys.has("KeyC") || this.keys.has("ControlLeft") || this.keys.has("ControlRight");
      const vertical = (this.keys.has("Space") ? 1 : 0) - (descending ? 1 : 0);
      const boosted = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      this.flightState = requireFlightState(this.stepCreativeFlight(
        this.flightState,
        {forward, sideways, vertical, boosted},
        requireBasis(this.readHorizontalBasis()),
        requireFinite(deltaMilliseconds, "Voxel navigation frame delta"),
        this.bounds,
      ));
      this.applyFlightState(this.flightState);
    } else if (this.mode === firstPersonMode) {
      const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const sideways = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      const jumping = this.keys.has("Space");
      const sprinting = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      this.survivalState = requireSurvivalState(this.stepSurvivalWalk(
        this.survivalState,
        {forward, sideways, jumping, sprinting},
        requireBasis(this.readHorizontalBasis()),
        requireFinite(deltaMilliseconds, "Voxel navigation frame delta"),
        this.bounds,
        this.collisionAt,
      ));
      this.applySurvivalState(this.survivalState);
    }
    const position = this.viewPosition();
    this.writePlayerStateAttributes(position);
    const centerX = chunkCoordinate(position.x, this.edge);
    const centerY = chunkCoordinate(position.y, this.edge);
    const centerZ = chunkCoordinate(position.z, this.edge);
    const centerChanged = centerX !== this.lastViewCenterX
      || centerY !== this.lastViewCenterY
      || centerZ !== this.lastViewCenterZ;
    const forward = requireDirection(this.readViewForward());
    const directionChanged = forward.x * this.lastViewForward.x
      + forward.y * this.lastViewForward.y
      + forward.z * this.lastViewForward.z <= viewDirectionCosineThreshold;
    if (!centerChanged && !directionChanged) return;
    if (centerChanged) {
      this.lastViewCenterX = centerX;
      this.lastViewCenterY = centerY;
      this.lastViewCenterZ = centerZ;
      this.writeViewChunkAttributes();
    }
    this.lastViewForward = forward;
    this.viewChanged(centerX, centerY, centerZ, forward.x, forward.y, forward.z);
  }

  writeViewChunkAttributes() {
    this.canvas.setAttribute("data-view-chunk-x", String(this.lastViewCenterX));
    this.canvas.setAttribute("data-view-chunk-y", String(this.lastViewCenterY));
    this.canvas.setAttribute("data-view-chunk-z", String(this.lastViewCenterZ));
  }

  writePlayerStateAttributes(position) {
    this.canvas.setAttribute("data-view-y", position.y.toFixed(6));
    this.canvas.setAttribute(
      "data-player-grounded",
      String(this.movementMode === survivalWalkMovement && this.survivalState.grounded),
    );
  }

  stats() {
    const position = this.viewPosition();
    return {
      navigationMode: this.mode,
      movementMode: this.movementMode,
      viewX: position.x,
      viewY: position.y,
      viewZ: position.z,
      viewChunkX: this.lastViewCenterX,
      viewChunkY: this.lastViewCenterY,
      viewChunkZ: this.lastViewCenterZ,
      forwardX: this.lastViewForward.x,
      forwardY: this.lastViewForward.y,
      forwardZ: this.lastViewForward.z,
      pointerLocked: this.pointerLocked,
    };
  }

  viewPosition() {
    return requirePosition(this.readViewPosition(), "Voxel navigation view position");
  }

  release() {
    if (this.released) return;
    const ownsCanvas = this.ownsCanvas();
    this.released = true;
    this.clearMotion();
    if (this.mode === firstPersonMode) {
      this.detachFirstPersonInput();
      if (ownsCanvas) this.canvas.setAttribute("data-pointer-locked", "false");
      this.exitOwnedPointerLock();
      this.finishReleasedPointerLockLifecycle();
    }
    this.releaseView();
    this.pointerLocked = false;
  }
}

export function createNavigationAdapter(options) {
  return new BabylonVoxelNavigation(options);
}
