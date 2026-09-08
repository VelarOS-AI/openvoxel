import {ArcRotateCamera} from "@babylonjs/core/Cameras/arcRotateCamera.js";
import {UniversalCamera} from "@babylonjs/core/Cameras/universalCamera.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";

const firstPersonMode = "first-person";
const creativeEyeHeight = 1.62;
const maximumCreativePitch = Math.PI / 2 - 0.02;

export function createNavigationCamera(scene, canvas, options, target, edge, horizontalChunkRadius, renderDistance) {
  if (options.navigationMode === firstPersonMode) {
    const survival = options.movementMode === "survival-walk";
    const minimumY = survival ? options.minimumWorldY + options.survivalEyeHeight : options.minimumWorldY + 0.25;
    const maximumY = survival
      ? options.maximumWorldY + 1 - (options.survivalPlayerHeight - options.survivalEyeHeight)
      : options.maximumWorldY + 0.75;
    const eyeHeight = survival ? options.survivalEyeHeight : creativeEyeHeight;
    const position = new Vector3(
      target.x + 0.5,
      Math.max(minimumY, Math.min(maximumY, target.y + eyeHeight)),
      target.z + 0.5,
    );
    const camera = new UniversalCamera("voxel-camera", position, scene);
    camera.inputs.clear();
    camera.inertia = 0;
    camera.speed = 0;
    camera.minZ = 0.05;
    // The sky sphere follows the camera at 2.5 render distances. Keep it inside
    // the far plane while leaving terrain fog to provide the distant cutoff.
    camera.maxZ = renderDistance * 3.2;
    camera.fov = 1.05;
    camera.checkCollisions = false;
    camera.applyGravity = false;
    camera.setTarget(new Vector3(target.x + edge, position.y - edge * 0.08, target.z - edge));
    return camera;
  }
  const orbitTarget = target.add(new Vector3(0, edge * 0.2, 0));
  const camera = new ArcRotateCamera("voxel-camera", -Math.PI / 4, Math.PI / 4.5, edge * 2.25, orbitTarget, scene);
  camera.lowerRadiusLimit = edge * 0.5;
  camera.upperRadiusLimit = edge * Math.max(2.5, horizontalChunkRadius - 0.5);
  camera.lowerBetaLimit = 0.08;
  camera.upperBetaLimit = Math.PI / 2.35;
  camera.checkCollisions = true;
  camera.collisionRadius = new Vector3(0.35, 0.7, 0.35);
  camera.wheelPrecision = 45;
  camera.panningSensibility = 720;
  camera.attachControl(canvas, true);
  return camera;
}

export function createNavigation(canvas, options, camera, dependencies) {
  const firstPerson = options.navigationMode === firstPersonMode;
  const survival = options.movementMode === "survival-walk";
  const minimumY = survival ? options.minimumWorldY : options.minimumWorldY + 0.25;
  const maximumY = survival ? options.maximumWorldY : options.maximumWorldY + 0.75;
  let forwardX = 0;
  let forwardZ = -1;
  const readViewPosition = () => firstPerson ? camera.position : camera.target;
  const readViewForward = () => {
    const direction = camera.getForwardRay().direction;
    return {x: direction.x, y: direction.y, z: direction.z};
  };
  const readHorizontalBasis = () => {
    const direction = camera.getForwardRay().direction;
    const length = Math.hypot(direction.x, direction.z);
    if (length > 0.000001) {
      forwardX = direction.x / length;
      forwardZ = direction.z / length;
    }
    return {forwardX, forwardZ, rightX: -forwardZ, rightZ: forwardX};
  };
  const applyFlightState = (state) => {
    camera.position.set(state.x, state.y, state.z);
  };
  const applySurvivalState = (state) => {
    camera.position.set(state.x, state.y, state.z);
  };
  const rotateView = (horizontalRadians, verticalRadians) => {
    camera.rotation.y -= horizontalRadians;
    camera.rotation.x = Math.max(
      -maximumCreativePitch,
      Math.min(maximumCreativePitch, camera.rotation.x - verticalRadians),
    );
  };
  const releaseView = () => {
    if (!firstPerson) camera.detachControl(canvas);
  };
  const initial = readViewPosition();
  return dependencies.createNavigation({
    canvas,
    mode: options.navigationMode,
    movementMode: options.movementMode,
    edge: options.edge,
    bounds: {minimumY, maximumY},
    initialState: dependencies.createFlightState(initial.x, initial.y, initial.z),
    initialSurvivalState: dependencies.createSurvivalState(initial.x, initial.y, initial.z),
    stepCreativeFlight: dependencies.stepFlight,
    stepSurvivalWalk: dependencies.stepSurvival,
    collisionAt: options.collisionAt,
    readViewPosition,
    readViewForward,
    readHorizontalBasis,
    applyFlightState,
    applySurvivalState,
    rotateView,
    releaseView,
    viewChanged: options.viewChanged,
  });
}
