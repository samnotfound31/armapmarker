import { expect, type Page } from "@playwright/test";

// Only the hardware boundary is synthetic. Camera playback/metadata, calibration,
// OpenCV, worker tracking, session management and Three.js remain real.
export async function installSyntheticDevice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // A local self-signed certificate cannot validate a service-worker fetch.
    // Keep service workers enabled for the real HTTPS Preview run.
    if (location.hostname === "127.0.0.1") {
      Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    }
    Object.defineProperty(Object.getPrototypeOf(screen.orientation), "angle", {
      configurable: true, get: () => 0
    });
    const state = {
      cameraCalls: 0, orientationPrompts: 0, motionPrompts: 0,
      permissionsWithoutGesture: 0, watches: new Map<number, number>(),
      streams: [] as MediaStream[], textured: true, overlayPixels: 0,
      pitch: 80, roll: 0, headingDeg: 0, headingAvailable: true,
      latitude: 20.353, longitude: 85.819, accuracyMeters: 15, fixAgeMs: 0
    };
    Object.assign(window, { __SYNTHETIC_DEVICE__: state });
    // Observe actual overlay pixels immediately after drawing (the default
    // framebuffer need not be preserved between frames). Never sample video.
    let lastRead = 0;
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function(...args) {
      clear.apply(this, args);
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.classList.contains("ar-overlay") && performance.now() - lastRead > 450) {
        state.overlayPixels = 0;
      }
    };
    const drawElements = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function(...args) {
      drawElements.apply(this, args);
      if (!(this.canvas instanceof HTMLCanvasElement) || !this.canvas.classList.contains("ar-overlay") || performance.now() - lastRead < 250) return;
      lastRead = performance.now();
      queueMicrotask(() => {
      const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4);
      this.readPixels(0,0,this.drawingBufferWidth,this.drawingBufferHeight,this.RGBA,this.UNSIGNED_BYTE,pixels);
      let green = 0;
      for (let i=0;i<pixels.length;i+=16) {
        if (pixels[i+1]! > pixels[i]! * 1.5 && pixels[i+3]! > 20) {
          green++;
        }
      }
      state.overlayPixels = green;
      });
    };
    const fix = () => ({
      coords: {
        latitude: state.latitude, longitude: state.longitude, accuracy: state.accuracyMeters,
        altitude: 42, altitudeAccuracy: 8, heading: 0, speed: 0
      }, timestamp: Date.now() - state.fixAgeMs
    } as GeolocationPosition);
    navigator.geolocation.getCurrentPosition = (success) => success(fix());
    navigator.geolocation.watchPosition = (success) => {
      const id = window.setInterval(() => success(fix()), 250);
      state.watches.set(id, id);
      return id;
    };
    navigator.geolocation.clearWatch = (id) => {
      clearInterval(id);
      state.watches.delete(id);
    };
    const recordGesture = () => {
      if (!navigator.userActivation.isActive) state.permissionsWithoutGesture++;
    };
    Object.defineProperty(DeviceOrientationEvent, "requestPermission", {
      configurable: true,
      value: async () => { recordGesture(); state.orientationPrompts++; return "granted"; }
    });
    Object.defineProperty(DeviceMotionEvent, "requestPermission", {
      configurable: true,
      value: async () => { recordGesture(); state.motionPrompts++; return "granted"; }
    });
    window.setInterval(() => {
      if (!state.orientationPrompts) return;
      const event = new Event("deviceorientation");
      Object.assign(event, {
        alpha: 0, beta: state.pitch, gamma: state.roll, absolute: false,
        ...(state.headingAvailable ? {
          webkitCompassHeading: state.headingDeg,
          webkitCompassAccuracy: 5
        } : {})
      });
      window.dispatchEvent(event);
    }, 50);
    Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => {
      recordGesture();
      state.cameraCalls++;
      const canvas = document.createElement("canvas");
      canvas.width = 720;
      canvas.height = 1280;
      const ctx = canvas.getContext("2d")!;
      const texture=document.createElement("canvas");texture.width=240;texture.height=426;
      const textureContext=texture.getContext("2d")!;
      const image=textureContext.createImageData(240,426);
      // Model the hardware image from geographic camera movement. A stationary
      // checkerboard during a GPS move contradicts the new full-motion estimator.
      const plane=()=>{
        const theta=state.headingDeg*Math.PI/180,beta=state.pitch*Math.PI/180;
        const c=Math.cos(theta),s=Math.sin(theta),sb=Math.sin(beta),cb=Math.cos(beta);
        const e=(state.longitude-85.819)*111319.49079327358*Math.cos(20.353*Math.PI/180);
        const n=(state.latitude-20.353)*111319.49079327358,h=1.4,f=720/(2*Math.tan(65*Math.PI/360));
        const tx=-c*e+s*n,ty=s*cb*e+sb*h+c*cb*n,tz=-s*sb*e+cb*h-c*sb*n;
        return [f*c+360*s*sb,-f*s*cb+640*s*sb,s*sb,-f*s+360*c*sb,-f*c*cb+640*c*sb,c*sb,f*tx+360*tz,f*ty+640*tz,tz];
      };
      const inverse=(m:number[])=>{const [a,d,g,b,e,h,c,f,i]=m as [number,number,number,number,number,number,number,number,number];const determinant=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);return [(e*i-f*h),(f*g-d*i),(d*h-e*g),(c*h-b*i),(a*i-c*g),(b*g-a*h),(b*f-c*e),(c*d-a*f),(a*e-b*d)].map(v=>v/determinant);};
      const draw = () => {
        ctx.fillStyle="#222";ctx.fillRect(0,0,canvas.width,canvas.height);if(!state.textured)return;
        // Fixed metric road texture: walking reveals equally detailed fresh
        // ground, rather than magnifying texture defined on the first image.
        const mapping=inverse(plane());
        for(let y=0;y<426;y++)for(let x=0;x<240;x++){
          const px=(x+.5)*3,py=(y+.5)*1280/426,d=mapping[2]!*px+mapping[5]!*py+mapping[8]!;
          const u=(mapping[0]!*px+mapping[3]!*py+mapping[6]!)/d,v=(mapping[1]!*px+mapping[4]!*py+mapping[7]!)/d;
          const sx=Math.floor(u*96),sy=Math.floor(v*96),gx=((sx%24)+24)%24,gy=((sy%24)+24)%24;
          const shade=d>0&&gx>=4&&gx<14&&gy>=4&&gy<14?70+(((Math.floor(sx/24)*17+Math.floor(sy/24)*29)%180)+180)%180:34;
          const at=(y*240+x)*4;image.data[at]=shade;image.data[at+1]=shade;image.data[at+2]=shade;image.data[at+3]=255;
        }
        textureContext.putImageData(image,0,0);ctx.drawImage(texture,0,0,720,1280);
      };
      draw();
      const stream = canvas.captureStream(20);
      const timer = window.setInterval(() => {
        if (stream.getTracks().every((track) => track.readyState === "ended")) {
          clearInterval(timer);
          return;
        }
        draw();
      }, 50);
      state.streams.push(stream);
      return stream;
    };
  });
}

export async function alignActualCalibration(page: Page): Promise<void> {
  const lock=page.getByRole("button",{name:"Lock alignment",exact:true});
  await expect(lock).toBeEnabled();
  await lock.click();
  await expect(page.getByLabel("Augmented reality navigation view")).toBeVisible();
}

declare global {
  interface Window {
    __SYNTHETIC_DEVICE__: {
      cameraCalls: number;
      orientationPrompts: number;
      motionPrompts: number;
      permissionsWithoutGesture: number;
      watches: Map<number, number>;
      streams: MediaStream[];
      textured: boolean;
      overlayPixels: number;
      pitch: number;
      roll: number;
      headingDeg: number;
      headingAvailable: boolean;
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      fixAgeMs: number;
    };
  }
}
