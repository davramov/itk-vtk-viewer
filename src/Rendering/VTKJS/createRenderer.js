import vtkGestureCameraManipulator
  from '@kitware/vtk.js/Interaction/Manipulators/GestureCameraManipulator';
import createMainRenderer from './Main/createMainRenderer';

// Load the rendering profiles we want to use
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import '@kitware/vtk.js/Rendering/Profiles/Glyph';
import '@kitware/vtk.js/Rendering/Profiles/Volume';

// XR support
import vtkWebXRRenderWindowHelper
  from '@kitware/vtk.js/Rendering/WebXR/RenderWindowHelper';
import { XrSessionTypes }
  from '@kitware/vtk.js/Rendering/WebXR/RenderWindowHelper/Constants';

/**
 * Sets up the main renderer, interactor, and WebXR integration with performance tweaks,
 * and head-locks the volume so head turns don’t move it.
 *
 * @param {object} context - Viewer context containing itkVtkView, renderWindow, and service.
 * @returns {itkVtkView} the configured view
 */
export default function createRenderer(context) {
  // ——— 1) Initial setup exactly as before ———
  const container = context.renderingViewContainers.get('volume');
  context.itkVtkView.setContainer(container);
  context.itkVtkView.setXyLowerLeft(context.xyLowerLeft);

  createMainRenderer(context);

  // gesture manipulator
  const gestureManipulator = vtkGestureCameraManipulator.newInstance({
    pinchEnabled: true,
    rotateEnabled: true,
    panEnabled: true,
  });
  context.itkVtkView.getInteractorStyle2D().addGestureManipulator(gestureManipulator);
  context.itkVtkView.getInteractorStyle3D().addGestureManipulator(gestureManipulator);

  const interactor = context.itkVtkView.getInteractor();
  interactor.onRenderEvent(() => context.service.send('POST_RENDER'));

  // better VR perf
  if (context.renderWindow.setMultiSamples) {
    context.renderWindow.setMultiSamples(0);
  }
  context.service.send({
    type: 'IMAGE_GRADIENT_OPACITY_SCALE_CHANGED',
    data: {
      name: context.images.selectedName,
      gradientOpacityScale: Number(0.1),
    },
  })
  context.service.send({
    type: 'IMAGE_GRADIENT_OPACITY_CHANGED',
    data: {
      name: context.images.selectedName,
      gradientOpacity: Number(0.01),
    },
  })
  // ensure a known camera pose
  const renderer = context.itkVtkView.getRenderer();
  renderer.resetCamera();

  // ——— 2) Grab the volume actor ———
  // Assumes exactly one volume in the scene
  const volumes = renderer.getVolumes();
  const volumeActor = volumes && volumes.length > 0 ? volumes[0] : null;
  if (!volumeActor) {
    console.warn('[createRenderer] No volume actor found; head-lock disabled.');
  }

  

  // ——— 3) WebXR setup ———
  const glRenderWindow = context.itkVtkView.getOpenGLRenderWindow();
  const xrHelper = vtkWebXRRenderWindowHelper.newInstance({ renderWindow: glRenderWindow });

  // VR toggle UI (unchanged)
  const vrButton = document.createElement('button');
  Object.assign(vrButton.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    padding: '16px 32px',
    backgroundColor: '#4CAF50',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '18px',
    fontWeight: 'bold',
    cursor: 'pointer',
    zIndex: '99999',
    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
  });
  vrButton.id = 'enterVRButton';
  vrButton.textContent = 'Enter VR';
  document.body.appendChild(vrButton);

  // We'll compute this once when VR starts:
  let lockedDistance = 1.0;

  vrButton.addEventListener('click', async () => {
    if (xrHelper.getXrSession()) {
      // exit VR
      await xrHelper.stopXR();
      vrButton.textContent = 'Enter VR';
      vrButton.style.backgroundColor = '#4CAF50';
      return;
    }

    // start VR
    try {
      vrButton.disabled = true;
      vrButton.textContent = 'Starting VR...';

      const session = await xrHelper.startXR(
        XrSessionTypes.HmdVR,
        { framebufferScaleFactor: 0.01 }
      );

      // — compute the initial distance between camera and volume center —
      if (volumeActor) {
        const cam = renderer.getActiveCamera();
        const camPos = cam.getPosition();
        const camFP = cam.getFocalPoint();
        const dx = camFP[0] - camPos[0];
        const dy = camFP[1] - camPos[1];
        const dz = camFP[2] - camPos[2];
        lockedDistance = Math.hypot(dx, dy, dz);
      }

      vrButton.textContent = 'Exit VR';
      vrButton.style.backgroundColor = '#F44336';
      vrButton.disabled = false;

      session.addEventListener('end', () => {
        vrButton.textContent = 'Enter VR';
        vrButton.style.backgroundColor = '#4CAF50';
      });
    } catch (error) {
      console.error('Failed to start VR session:', error);
      vrButton.textContent = 'VR Failed';
      vrButton.style.backgroundColor = '#F44336';
      setTimeout(() => {
        vrButton.textContent = 'Enter VR';
        vrButton.style.backgroundColor = '#4CAF50';
        vrButton.disabled = false;
      }, 2000);
    }
  });

  // Expose for debugging
  global.xrHelper = xrHelper;
  global.context = context;
  global.enterVR = () => xrHelper.startXR(XrSessionTypes.HmdVR, { framebufferScaleFactor: 0.5 });

  // ——— 4) FPS guard + head-lock on each render event ———
  let lastFrameTime = performance.now();
  interactor.onRenderEvent(() => {
    const now = performance.now();
    const fps = 1000 / (now - lastFrameTime);
    lastFrameTime = now;

    if (xrHelper.getXrSession()) {
      // auto-exit on low FPS
      if (fps < 15) {
        console.warn(`Low FPS detected (${fps.toFixed(1)}fps): exiting VR mode`);
        xrHelper.stopXR();
        vrButton.textContent = 'Enter VR';
        vrButton.style.backgroundColor = '#4CAF50';
        return;
      }

      // head-lock the volume
      if (volumeActor) {
        const cam = renderer.getActiveCamera();
        const pos = cam.getPosition();
        const fp = cam.getFocalPoint();
        // compute forward vector and normalize
        const vx = fp[0] - pos[0];
        const vy = fp[1] - pos[1];
        const vz = fp[2] - pos[2];
        const L = Math.hypot(vx, vy, vz) || 1;
        // place volume at fixed distance straight ahead
        volumeActor.setPosition(
          pos[0] + (vx / L) * lockedDistance,
          pos[1] + (vy / L) * lockedDistance,
          pos[2] + (vz / L) * lockedDistance
        );
      }
    }
  });

  return context.itkVtkView;
}
