(() => {
  'use strict';
  const screens = Object.fromEntries(['home','camera','error','preview'].map(name => [name, document.getElementById(`${name}Screen`)]));
  const video = document.getElementById('cameraVideo');
  const cameraStage = document.getElementById('cameraStage');
  const trackingOverlay = document.getElementById('trackingOverlay');
  const demoToggle = document.getElementById('demoToggle');
  const recordButton = document.getElementById('recordButton');
  const recorderBadge = document.getElementById('recordingBadge');
  const timerLabel = document.getElementById('recordingTimer');
  const recordedVideo = document.getElementById('recordedVideo');
  const videoEmpty = document.getElementById('videoEmpty');
  const toast = document.getElementById('toast');
  let stream = null, recorder = null, chunks = [], recordingStartedAt = 0, timerInterval = null, guidanceInterval = null, detectionTimer = null, toastTimeout = null, previewUrl = null, facingMode = 'user', discardOnStop = false, detector = null, detectorLoadPromise = null, detectorGeneration = 0, detectionBusy = false, detectionFailed = false;
  let faceDetector = null, lockedSubject = null, visibleCandidates = [], outputCanvas = null, outputContext = null, outputStream = null, drawFrameId = 0, cropState = null, lastDrawAt = 0, recordingHadLock = false;
  let photoMode = false;
  const directions = [{arrow:'↑',text:'Move Up',className:'up'},{arrow:'→',text:'Move Right',className:''},{arrow:'↓',text:'Move Down',className:'down'},{arrow:'←',text:'Move Left',className:'left'}];
  let directionIndex = 0;

  function showScreen(name) {
    Object.entries(screens).forEach(([key, screen]) => { const active = key === name; screen.hidden = !active; screen.classList.toggle('active', active); });
    if (name !== 'camera') clearInterval(guidanceInterval);
    if (name === 'camera' && demoToggle.checked) startGuidance();
  }
  function startGuidance() {
    clearInterval(guidanceInterval);
    if (!demoToggle.checked || screens.camera.hidden) return;
    updateGuidance();
    guidanceInterval = setInterval(updateGuidance, 3200);
  }
  function updateGuidance() {
    const guidance = document.getElementById('guidance');
    const item = directions[directionIndex++ % directions.length];
    guidance.className = `guidance ${item.className}`.trim();
    guidance.querySelector('.guidance-arrow').textContent = item.arrow;
    guidance.lastElementChild.textContent = item.text;
  }
  function setGuidance(text, arrow = '✓', position = '') {
    const guidance = document.getElementById('guidance');
    guidance.className = `guidance ${position}`.trim();
    guidance.querySelector('.guidance-arrow').textContent = arrow;
    guidance.lastElementChild.textContent = text;
  }
  function updateDemoMode() {
    document.getElementById('demoDescription').textContent = demoToggle.checked ? 'AI Detection Demo · max 3 objects' : 'Live detector · max 3 objects';
    setDetectorIndicator();
    document.getElementById('trackingStatus').textContent = demoToggle.checked ? 'AI Detection Demo' : 'AI object detection active';
    if (detectionFailed) renderFallback();
    else trackingOverlay.classList.add('disabled');
    if (!detector && demoToggle.checked) startGuidance(); else clearInterval(guidanceInterval);
  }
  function setDetectorIndicator(loading = false) {
    const label = document.getElementById('detectorIndicator');
    label.lastChild.textContent = detectionFailed ? (demoToggle.checked ? ' AI DETECTION DEMO' : ' DETECTION OFFLINE') : loading ? ' AI DETECTION: LOADING' : demoToggle.checked ? ' AI DETECTION DEMO' : ' AI OBJECT DETECTION: ON';
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src; script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }
  async function loadDetector() {
    if (detector) return detector;
    if (!detectorLoadPromise) detectorLoadPromise = (async () => {
      if (!window.tf) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      if (!window.cocoSsd) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
      await window.tf.ready();
      return window.cocoSsd.load({base:'lite_mobilenet_v2'});
    })();
    detector = await detectorLoadPromise;
    return detector;
  }
  async function loadFaceDetector() {
    if (faceDetector) return faceDetector;
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
    faceDetector = await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'},
      runningMode:'VIDEO', minDetectionConfidence:.5
    });
    return faceDetector;
  }
  async function initializeDetector() {
    const generation = ++detectorGeneration;
    detectionFailed = false;
    setDetectorIndicator(true);
    document.getElementById('detectorCount').textContent = 'Loading object detector…';
    document.getElementById('trackingStatus').textContent = demoToggle.checked ? 'AI Detection Demo · loading' : 'Loading object detector';
    try {
      await loadDetector();
      if (generation !== detectorGeneration || !stream) return;
      try { await loadFaceDetector(); }
      catch (error) { console.warn('Face landmarks unavailable; object-center tracking remains available.', error); }
      if (generation !== detectorGeneration || !stream) return;
      setDetectorIndicator();
      document.getElementById('trackingStatus').textContent = demoToggle.checked ? 'AI Detection Demo' : 'AI object detection active';
      trackingOverlay.classList.add('disabled');
      clearInterval(guidanceInterval);
      runDetectionLoop(generation);
    } catch (error) {
      console.warn('Object detector unavailable; using demo fallback.', error);
      if (generation !== detectorGeneration) return;
      detectionFailed = true;
      setDetectorIndicator();
      document.getElementById('detectorCount').textContent = 'Detection unavailable · demo boxes';
      renderFallback();
      if (demoToggle.checked) startGuidance();
    }
  }
  async function runDetectionLoop(generation) {
    if (generation !== detectorGeneration || !stream || screens.camera.hidden || detectionBusy) return;
    if (video.readyState < 2 || !video.videoWidth) { detectionTimer = setTimeout(() => runDetectionLoop(generation), 350); return; }
    detectionBusy = true;
    try {
      const predictions = await detector.detect(video, 20);
      if (generation !== detectorGeneration || !stream) return;
      detectionFailed = false;
      setDetectorIndicator();
      const candidates = predictions.filter(p => p.score >= 0.35 && p.bbox?.length === 4).map(p => ({type:'object', className:p.class, score:p.score, bbox:p.bbox, point:{x:p.bbox[0]+p.bbox[2]/2,y:p.bbox[1]+p.bbox[3]/2}}));
      if (faceDetector) {
        try {
          const results = faceDetector.detectForVideo(video, performance.now());
          for (const face of results.detections || []) {
            const box = face.boundingBox;
            if (!box) continue;
            const keypoints = face.keypoints || [];
            const nose = keypoints[2];
            const eyes = keypoints.length > 1 ? keypoints.slice(0,2) : [];
            const point = nose ? {x:nose.x*video.videoWidth,y:nose.y*video.videoHeight} : eyes.length ? {x:eyes.reduce((s,p)=>s+p.x,0)/eyes.length*video.videoWidth,y:eyes.reduce((s,p)=>s+p.y,0)/eyes.length*video.videoHeight} : {x:box.originX+box.width/2,y:box.originY+box.height/2};
            candidates.push({type:'face',className:'face',score:face.categories?.[0]?.score || .8,bbox:[box.originX,box.originY,box.width,box.height],point});
          }
        } catch (error) { console.warn('Face detection frame failed.', error); }
      }
      drawDetections(candidates);
    } catch (error) {
      console.warn('Object detection frame failed.', error);
      if (demoToggle.checked) { detectionFailed = true; renderFallback(); }
    } finally {
      detectionBusy = false;
      if (generation === detectorGeneration && stream && !screens.camera.hidden) detectionTimer = setTimeout(() => runDetectionLoop(generation), 550);
    }
  }
  function drawDetections(candidates) {
    const layer = document.getElementById('detectedObjects');
    layer.replaceChildren();
    trackingOverlay.classList.add('disabled');
    const frameArea = Math.max(1,video.videoWidth*video.videoHeight);
    const rank = (a,b) => (b.score*(.65+Math.sqrt((b.bbox[2]*b.bbox[3])/frameArea)))-(a.score*(.65+Math.sqrt((a.bbox[2]*a.bbox[3])/frameArea)));
    let chosen = candidates.slice().sort(rank).slice(0,3);
    let currentLock = lockedSubject ? findLockedCandidate(candidates, lockedSubject) : null;
    if (currentLock) {
      lockedSubject.lastBox = currentLock.bbox.slice();
      lockedSubject.lastPoint = {...currentLock.point};
      lockedSubject.score = currentLock.score;
      if (!chosen.includes(currentLock)) chosen = [...chosen.slice(0,2),currentLock];
    } else if (lockedSubject && recorder?.state === 'recording') {
      currentLock = {...lockedSubject,type:lockedSubject.type,className:lockedSubject.className,bbox:lockedSubject.lastBox,point:lockedSubject.lastPoint,lost:true};
      if (!chosen.some(c => c.type===currentLock.type)) chosen = [...chosen.slice(0,2),currentLock];
    }
    chosen.sort((a,b) => (b===currentLock?1:0)-(a===currentLock?1:0));
    visibleCandidates = chosen;
    document.getElementById('detectorCount').textContent = `Tracking ${chosen.length} subject${chosen.length === 1 ? '' : 's'} · tap to lock`;
    document.getElementById('trackingStatus').textContent = demoToggle.checked ? `AI Detection Demo · ${chosen.length} tracked` : `AI object detection · ${chosen.length} tracked`;
    const stageRect = cameraStage.getBoundingClientRect();
    const scale = Math.max(stageRect.width / video.videoWidth, stageRect.height / video.videoHeight);
    const offsetX = (stageRect.width - video.videoWidth * scale) / 2;
    const offsetY = (stageRect.height - video.videoHeight * scale) / 2;
    chosen.forEach((prediction, index) => {
      const [x,y,w,h] = prediction.bbox;
      const box = document.createElement('div');
      const isLocked = !!lockedSubject && prediction.type===lockedSubject.type && prediction.className===lockedSubject.className && (prediction===currentLock || prediction.lost);
      box.className = `object-box object-box-${index+1}${prediction.type==='face'?' face-object-box':''}${isLocked?' is-locked':''}${prediction.lost?' is-lost':''}`;
      box.style.left = `${stageRect.width - (x * scale + offsetX) - w * scale}px`;
      box.style.top = `${y * scale + offsetY}px`;
      box.style.width = `${w * scale}px`;
      box.style.height = `${h * scale}px`;
      box.setAttribute('role','button'); box.tabIndex=0;
      box.setAttribute('aria-label',`${isLocked?'Locked ':'Lock '}${prediction.className}`);
      box.addEventListener('click', event => { event.stopPropagation(); lockSubject(prediction); });
      box.addEventListener('keydown', event => { if(event.key==='Enter'||event.key===' '){event.preventDefault();lockSubject(prediction);} });
      const label = document.createElement('span');
      label.className = 'object-label';
      label.textContent = `${isLocked?'LOCKED · ':''}${prediction.className.toUpperCase()} ${Math.round(prediction.score * 100)}%${prediction.lost?' · SEARCHING':''}`;
      box.append(label);
      if (prediction.type==='face' && prediction.point) {
        const point=document.createElement('span'); point.className='box-lock-point'; point.textContent='+';
        point.style.left=`${(prediction.point.x-x)/w*100}%`; point.style.top=`${(prediction.point.y-y)/h*100}%`; box.append(point);
      }
      layer.append(box);
    });
    if (currentLock) { updateLockUI(currentLock,stageRect,scale,offsetX,offsetY); updateObjectGuidance(currentLock.bbox); }
    else if (lockedSubject) { updateLockUI({...lockedSubject,bbox:lockedSubject.lastBox,point:lockedSubject.lastPoint,lost:true},stageRect,scale,offsetX,offsetY); }
    else { document.getElementById('lockIndicator').classList.remove('visible'); document.getElementById('lockPointMarker').classList.remove('visible'); }
    if (!lockedSubject && chosen.length) updateObjectGuidance(chosen[0].bbox);
    else if (!chosen.length && !lockedSubject) setGuidance('Looking for subjects', '⌕');
  }
  function updateObjectGuidance([x,y,w,h]) {
    const sourceCenterX = (x + w / 2) / video.videoWidth;
    const centerX = facingMode === 'user' ? 1 - sourceCenterX : sourceCenterX;
    const centerY = (y + h / 2) / video.videoHeight;
    const marginX = .24, marginY = .25;
    if (centerX < marginX) setGuidance('Move camera RIGHT', '→', 'left');
    else if (centerX > 1-marginX) setGuidance('Move camera LEFT', '←');
    else if (centerY < marginY) setGuidance('Move camera DOWN', '↓', 'up');
    else if (centerY > 1-marginY) setGuidance('Move camera UP', '↑', 'down');
    else setGuidance('Subject well framed ✓', '✓');
  }
  function lockSubject(candidate) {
    lockedSubject = {type:candidate.type,className:candidate.className,lastBox:candidate.bbox.slice(),lastPoint:{...candidate.point},score:candidate.score};
    if (recorder?.state === 'recording') recordingHadLock = true;
    const rect=cameraStage.getBoundingClientRect();
    const scale=Math.max(rect.width/video.videoWidth,rect.height/video.videoHeight);
    updateLockUI(candidate,rect,scale,(rect.width-video.videoWidth*scale)/2,(rect.height-video.videoHeight*scale)/2);
    showToast(`${candidate.className === 'face' ? 'Face' : candidate.className} locked. Recording will follow this subject.`);
  }
  function findLockedCandidate(candidates, subject) {
    if (!subject?.lastPoint) return null;
    let best=null, bestScore=Infinity;
    for (const candidate of candidates) {
      if (candidate.type!==subject.type || candidate.className!==subject.className) continue;
      const dx=(candidate.point.x-subject.lastPoint.x)/video.videoWidth;
      const dy=(candidate.point.y-subject.lastPoint.y)/video.videoHeight;
      const distance=Math.hypot(dx,dy);
      const score=distance - boxIoU(candidate.bbox,subject.lastBox)*.18;
      if(score<bestScore){best=candidate;bestScore=score;}
    }
    return bestScore < .55 ? best : null;
  }
  function boxIoU(a,b) {
    if(!a||!b) return 0;
    const x1=Math.max(a[0],b[0]),y1=Math.max(a[1],b[1]);
    const x2=Math.min(a[0]+a[2],b[0]+b[2]),y2=Math.min(a[1]+a[3],b[1]+b[3]);
    const intersection=Math.max(0,x2-x1)*Math.max(0,y2-y1);
    const union=a[2]*a[3]+b[2]*b[3]-intersection;
    return union>0?intersection/union:0;
  }
  function updateLockUI(subject,rect,scale,offsetX,offsetY) {
    const indicator=document.getElementById('lockIndicator');
    indicator.classList.add('visible');
    document.getElementById('lockLabel').textContent=`${subject.lost?'SEARCHING · ':'LOCKED · '}${subject.className.toUpperCase()}`;
    const marker=document.getElementById('lockPointMarker');
    const point=subject.point||subject.lastPoint;
    if(!point)return;
    marker.style.left=`${rect.width-(point.x*scale+offsetX)}px`;
    marker.style.top=`${point.y*scale+offsetY}px`;
    marker.classList.add('visible');
  }
  function renderFallback() {
    document.getElementById('detectedObjects').replaceChildren();
    trackingOverlay.classList.toggle('disabled', !demoToggle.checked);
    document.getElementById('detectorCount').textContent = demoToggle.checked ? 'Tracking 1 object · simulated' : 'No objects detected';
    document.getElementById('trackingStatus').textContent = demoToggle.checked ? 'AI Detection Demo · simulated boxes' : 'Detector unavailable';
  }
  function stopDetection() {
    detectorGeneration++;
    clearTimeout(detectionTimer);
    document.getElementById('detectedObjects').replaceChildren();
    detectionBusy = false;
  }
  async function startCamera() {
    showScreen('camera');
    if (!navigator.mediaDevices?.getUserMedia) { handleCameraError(new Error('Camera access is not supported by this browser.')); return; }
    try {
      if (stream) stopCamera();
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode}, audio:true});
      video.srcObject = stream;
      cameraStage.classList.add('has-video');
      await video.play().catch(() => {});
      detectorGeneration++;
      initializeDetector();
    } catch (error) { handleCameraError(error); }
  }
  function stopCamera() {
    stopDetection();
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    cameraStage.classList.remove('has-video');
  }
  function handleCameraError(error) {
    console.warn('Camera unavailable:', error);
    stopCamera();
    showScreen('error');
  }
  function startRecording() {
    if (!stream) { showToast('Start the camera before recording.'); return; }
    if (typeof MediaRecorder === 'undefined') { showToast('Video recording is not supported in this browser.'); return; }
    if (!lockedSubject && visibleCandidates.length) lockSubject(visibleCandidates[0]);
    if (!video.videoWidth || !video.videoHeight) { showToast('Wait for the camera and subject detector to become ready.'); return; }
    try {
      outputCanvas=document.createElement('canvas');
      outputCanvas.width=video.videoWidth; outputCanvas.height=video.videoHeight;
      outputContext=outputCanvas.getContext('2d',{alpha:false});
      if (!outputCanvas.captureStream || !outputContext) throw new Error('Canvas recording is not supported by this browser.');
      cropState={x:video.videoWidth/2,y:video.videoHeight/2};
      recordingHadLock=!!lockedSubject;
      lastDrawAt=0;
      drawOutputFrame();
      const canvasStream=outputCanvas.captureStream(30);
      outputStream=new MediaStream([...canvasStream.getVideoTracks(),...stream.getAudioTracks()]);
      const options = {};
      if (MediaRecorder.isTypeSupported?.('video/webm;codecs=vp9')) options.mimeType = 'video/webm;codecs=vp9';
      else if (MediaRecorder.isTypeSupported?.('video/webm;codecs=vp8')) options.mimeType = 'video/webm;codecs=vp8';
      recorder = new MediaRecorder(outputStream, options);
      chunks = [];
      recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener('stop', finishRecording, {once:true});
      recorder.addEventListener('error', () => showToast('The recording ended unexpectedly. Try again.'));
      recorder.start(250);
      recordingStartedAt = Date.now();
      cameraStage.classList.add('recording');
      document.getElementById('trackingStatus').textContent = lockedSubject ? 'Smart Tracking Active' : 'Center crop · no subject lock';
      document.getElementById('recordLockIndicator').textContent = lockedSubject ? 'LOCKED' : 'CENTER';
      recorderBadge.classList.add('visible');
      recordButton.classList.add('recording');
      recordButton.setAttribute('aria-label','Stop recording');
      document.getElementById('flipButton').disabled = true;
      document.getElementById('videoMode').disabled = true;
      document.getElementById('photoMode').disabled = true;
      document.getElementById('controlHint').textContent = 'Tap to stop recording';
      timerLabel.textContent = '00:00';
      timerInterval = setInterval(updateTimer, 250);
    } catch (error) { stopCanvasOutput(); showToast(`Could not start processed recording: ${error.message || 'unsupported format'}`); }
  }
  function drawOutputFrame() {
    if (!outputCanvas || !outputContext || !stream) return;
    const now=performance.now();
    if(now-lastDrawAt<30){drawFrameId=requestAnimationFrame(drawOutputFrame);return;}
    const elapsed=lastDrawAt?Math.min(80,now-lastDrawAt):33;
    lastDrawAt=now;
    const sourceW=video.videoWidth,sourceH=video.videoHeight;
    if(sourceW&&sourceH){
      const zoom=1.25;
      const cropW=sourceW/zoom,cropH=sourceH/zoom;
      const target=lockedSubject?.lastPoint||{x:sourceW/2,y:sourceH/2};
      const targetX=Math.min(sourceW-cropW/2,Math.max(cropW/2,target.x));
      const targetY=Math.min(sourceH-cropH/2,Math.max(cropH/2,target.y));
      const easing=1-Math.pow(.8,elapsed/33);
      cropState.x+=(targetX-cropState.x)*easing;
      cropState.y+=(targetY-cropState.y)*easing;
      const sx=Math.min(sourceW-cropW,Math.max(0,cropState.x-cropW/2));
      const sy=Math.min(sourceH-cropH,Math.max(0,cropState.y-cropH/2));
      outputContext.drawImage(video,sx,sy,cropW,cropH,0,0,outputCanvas.width,outputCanvas.height);
    }
    drawFrameId=requestAnimationFrame(drawOutputFrame);
  }
  function stopCanvasOutput() {
    if(drawFrameId) cancelAnimationFrame(drawFrameId);
    drawFrameId=0;
    if(outputStream) outputStream.getTracks().forEach(track=>track.stop());
    outputStream=null; outputCanvas=null; outputContext=null; cropState=null; lastDrawAt=0;
  }
  function updateTimer() {
    const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
    timerLabel.textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  }
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }
  function finishRecording() {
    clearInterval(timerInterval);
    cameraStage.classList.remove('recording');
    recorderBadge.classList.remove('visible');
    recordButton.classList.remove('recording');
    recordButton.setAttribute('aria-label','Start recording');
    document.getElementById('flipButton').disabled = false;
    document.getElementById('videoMode').disabled = false;
    document.getElementById('photoMode').disabled = false;
    document.getElementById('controlHint').textContent = photoMode ? 'Photo mode · camera capture unavailable' : 'Tap to start recording';
    if (discardOnStop) { discardOnStop = false; chunks = []; recorder = null; return; }
    const recordedMimeType = chunks.find(chunk => chunk.type?.toLowerCase().startsWith('video/'))?.type || recorder?.mimeType || '';
    if (!recordedMimeType.toLowerCase().startsWith('video/')) { stopCanvasOutput(); showToast('Your browser did not report a supported video format, so this recording cannot be saved safely.'); return; }
    const recordedBlob = new Blob(chunks, {type:recordedMimeType});
    const actualMimeType = recordedBlob.type;
    if (!actualMimeType.toLowerCase().startsWith('video/')) { stopCanvasOutput(); showToast('The recorded video format could not be identified safely.'); return; }
    if (!recordedBlob.size) { stopCanvasOutput(); showToast('No video data was captured. Please try recording again.'); return; }
    console.info('[SteadySight] Recorded video', {recorderMimeType:recorder?.mimeType || '', recordedBlobType:actualMimeType, sizeBytes:recordedBlob.size});
    stopCanvasOutput();
    showPreview(URL.createObjectURL(recordedBlob), false, recordedBlob);
  }
  function showPreview(url, isPhoto = false, mediaBlob = null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    const recordedPhoto = document.getElementById('recordedPhoto');
    recordedVideo.hidden = isPhoto;
    recordedPhoto.hidden = !isPhoto;
    if (isPhoto) recordedPhoto.src = previewUrl;
    else recordedVideo.src = previewUrl;
    videoEmpty.hidden = true;
    if (!isPhoto) {
      document.querySelector('.preview-heading .eyebrow').innerHTML='<span class="live-dot"></span> '+(recordingHadLock?'SMART TRACKING OUTPUT':'CENTER CROP OUTPUT');
      document.getElementById('previewTitle').innerHTML=recordingHadLock?'Smart Tracking<span>.</span>':'Video Captured<span>.</span>';
      document.querySelector('.preview-heading p').textContent=recordingHadLock?'This is the canvas-reframed video. SteadySight followed the locked subject during recording.':'This video was recorded through the reframed canvas, but no subject was locked.';
      document.querySelector('.result-card small').textContent=recordingHadLock?'Applied to recorded video':'No subject lock';
    }
    stopCamera();
    showScreen('preview');
    window.dispatchEvent(new CustomEvent('steadysight:capture', {detail:{blob:mediaBlob, type:isPhoto?'photo':'video', mimeType:mediaBlob?.type || ''}}));
  }
  function resetPrototype() {
    if (recorder && recorder.state !== 'inactive') { discardOnStop = true; recorder.stop(); }
    clearInterval(timerInterval);
    stopCanvasOutput();
    stopCamera();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    recordedVideo.removeAttribute('src');
    recordedVideo.load();
    const recordedPhoto = document.getElementById('recordedPhoto');
    recordedPhoto.removeAttribute('src');
    recordedPhoto.hidden = true;
    recordedVideo.hidden = false;
    videoEmpty.hidden = false;
    recorder = null;
    chunks = [];
    lockedSubject = null;
    recordingHadLock = false;
    visibleCandidates = [];
    document.getElementById('lockIndicator').classList.remove('visible');
    document.getElementById('lockPointMarker').classList.remove('visible');
    showScreen('home');
  }
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3000);
  }
  function capturePhoto() {
    if (!stream || video.readyState < 2) { showToast('Wait for the live camera preview to appear.'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (facingMode === 'user') { context.translate(canvas.width, 0); context.scale(-1, 1); }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => { if (blob) showPreview(URL.createObjectURL(blob), true, blob); else showToast('Could not capture a photo.'); }, 'image/jpeg', .92);
  }
  document.getElementById('startButton').addEventListener('click', startCamera);
  document.getElementById('retryButton').addEventListener('click', startCamera);
  document.getElementById('cameraHomeButton').addEventListener('click', resetPrototype);
  document.getElementById('errorHomeButton').addEventListener('click', resetPrototype);
  document.getElementById('errorBackButton').addEventListener('click', resetPrototype);
  document.getElementById('previewHomeButton').addEventListener('click', resetPrototype);
  document.getElementById('previewBackButton').addEventListener('click', resetPrototype);
  document.getElementById('recordAgainButton').addEventListener('click', startCamera);
  demoToggle.addEventListener('change', updateDemoMode);
  recordButton.addEventListener('click', () => { if (photoMode) capturePhoto(); else if (recorder?.state === 'recording') stopRecording(); else startRecording(); });
  document.getElementById('videoMode').addEventListener('click', () => setMode(false));
  document.getElementById('photoMode').addEventListener('click', () => setMode(true));
  document.getElementById('galleryButton').addEventListener('click', () => { if (previewUrl) showScreen('preview'); else showToast('Your latest capture will appear here.'); });
  document.getElementById('flipButton').addEventListener('click', async () => { facingMode = facingMode === 'user' ? 'environment' : 'user'; if (stream) await startCamera(); });
  document.getElementById('settingsButton').addEventListener('click', () => showToast('Camera settings are using your browser defaults.'));
  function setMode(photo) {
    photoMode = photo;
    document.getElementById('photoMode').classList.toggle('selected', photo);
    document.getElementById('videoMode').classList.toggle('selected', !photo);
    document.getElementById('photoMode').setAttribute('aria-selected', String(photo));
    document.getElementById('videoMode').setAttribute('aria-selected', String(!photo));
    document.getElementById('controlHint').textContent = photo ? 'Tap to capture a photo' : 'Tap to start recording';
    recordButton.setAttribute('aria-label', photo ? 'Take photo' : 'Start recording');
  }
  updateDemoMode();
})();
