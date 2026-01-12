
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * Sanitizes and extracts the HTML/JS document from the model's markdown response.
 * Handles both naked text and fenced code blocks.
 */
export const extractHtmlFromText = (text: string): string => {
  if (!text) return "";
  const htmlMatch = text.match(/(<!DOCTYPE html>|<html)[\s\S]*?<\/html>/i);
  if (htmlMatch) return htmlMatch[0];
  const codeBlockMatch = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  return text.trim();
};

/**
 * Normalizes the document by hiding external UI elements and ensuring a full-screen canvas.
 */
export const hideBodyText = (html: string): string => {
  const css = `
    <style>
      #info, #loading, #ui, #instructions, .label, .overlay, #description, .dg.ac {
        display: none !important; opacity: 0 !important; visibility: hidden !important;
      }
      body { margin: 0; overflow: hidden; background-color: transparent; }
      canvas { display: block; width: 100vw !important; height: 100vh !important; }
    </style>
  `;
  return injectIntoHead(html, css);
};

/**
 * Injects a message-based bridge into the sandbox for high-speed OBJ/VOX/GLTF exports.
 * UPDATED: Includes AO simulation and improved metrics reporting.
 */
export const injectExporterBridge = (html: string): string => {
  const bridgeScript = `
    <script type="module">
      import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

      function calculateMetrics() {
        let total = 0;
        let user = 0;
        const colors = new Set();
        if (typeof scene !== 'undefined') {
          scene.traverse((obj) => {
            if (obj.isInstancedMesh) {
              total += obj.count;
              if (obj.name === 'UserLayer') user += obj.count;
              if (obj.instanceColor) {
                // Approximate color counting by looking at the first few instances or the material
                colors.add(obj.material.color.getHex());
              }
            }
          });
        }
        return { 
          totalVoxels: total, 
          userVoxels: user, 
          uniqueColors: colors.size,
          estimatedMemory: (total * 64 / 1024 / 1024).toFixed(2) + 'MB'
        };
      }

      // Report metrics periodically
      setInterval(() => {
        window.parent.postMessage({ type: 'SCENE_METRICS', metrics: calculateMetrics() }, '*');
      }, 2000);

      window.addEventListener('message', async (event) => {
        if (!event.data) return;

        const { type, format, options = {} } = event.data;

        if (type === 'GET_SNAPSHOT' && typeof renderer !== 'undefined') {
          if (typeof scene !== 'undefined' && typeof camera !== 'undefined') renderer.render(scene, camera);
          const dataUrl = renderer.domElement.toDataURL('image/webp', 0.8);
          window.parent.postMessage({ type: 'SNAPSHOT_RESULT', dataUrl }, '*');
        }

        if (type === 'EXPORT_SCENE') {
          const rawVoxels = [];
          if (typeof scene !== 'undefined') {
            scene.traverse((obj) => {
              if (obj.isInstancedMesh || obj.name === 'UserLayer') {
                const matrix = new THREE.Matrix4();
                const color = new THREE.Color();
                const scale = new THREE.Vector3();
                const pos = new THREE.Vector3();
                const count = obj.count !== undefined ? obj.count : 0;
                
                for (let i = 0; i < count; i++) {
                  obj.getMatrixAt(i, matrix);
                  matrix.decompose(pos, new THREE.Quaternion(), scale);
                  if (scale.x < 0.1) continue;

                  obj.getColorAt(i, color);
                  rawVoxels.push({ 
                    x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), 
                    r: color.r, g: color.g, b: color.b,
                    hex: color.getHexString()
                  });
                }
              }
            });
          }

          let processedVoxels = rawVoxels;
          let scaleFactor = 1;
          
          if (options.lod === 'Med' || options.lod === 'Low') {
             scaleFactor = options.lod === 'Med' ? 2 : 4;
             const grid = new Map();
             rawVoxels.forEach(v => {
                const gx = Math.floor(v.x / scaleFactor);
                const gy = Math.floor(v.y / scaleFactor);
                const gz = Math.floor(v.z / scaleFactor);
                const key = \`\${gx},\${gy},\${gz}\`;
                if (!grid.has(key)) grid.set(key, { x: gx, y: gy, z: gz, r:0, g:0, b:0, count:0 });
                const cell = grid.get(key);
                cell.r += v.r; cell.g += v.g; cell.b += v.b; cell.count++;
             });
             processedVoxels = Array.from(grid.values()).map(v => ({
                x: v.x * scaleFactor, y: v.y * scaleFactor, z: v.z * scaleFactor,
                r: v.r / v.count, g: v.g / v.count, b: v.b / v.count,
                hex: new THREE.Color(v.r/v.count, v.g/v.count, v.b/v.count).getHexString()
             }));
          }

          const voxelMap = new Map();
          processedVoxels.forEach(v => voxelMap.set(\`\${v.x},\${v.y},\${v.z}\`, v));

          const vertices = [];
          const normals = [];
          const colors = [];
          const uvs = [];

          const addFace = (v, dir, uOffset) => {
             let nx=0, ny=0, nz=0, dx=0, dy=0, dz=0, qx=0, qy=0, qz=0;
             const hs = (1 * scaleFactor) / 2;
             const cx = v.x, cy = v.y, cz = v.z;

             if (dir === 'px') { nx=1; dx=0; dy=0; dz=-1; qx=0; qy=-1; qz=0; }
             if (dir === 'nx') { nx=-1; dx=0; dy=0; dz=1; qx=0; qy=-1; qz=0; }
             if (dir === 'py') { ny=1; dx=1; dy=0; dz=0; qx=0; qy=0; qz=1; }
             if (dir === 'ny') { ny=-1; dx=1; dy=0; dz=0; qx=0; qy=0; qz=-1; }
             if (dir === 'pz') { nz=1; dx=1; dy=0; dz=0; qx=0; qy=-1; qz=0; }
             if (dir === 'nz') { nz=-1; dx=-1; dy=0; dz=0; qx=0; qy=-1; qz=0; }

             const getAO = (vX, vY, vZ, nX, nY, nZ, d1, d2, q1, q2) => {
               if (!options.bakeAO) return 1.0;
               // Simplified AO based on neighbors
               let count = 0;
               if (voxelMap.has(\`\${vX+nX+d1},\${vY+nY+d2},\${vZ+nZ+q1}\`)) count++;
               return 1.0 - (count * 0.15);
             };

             const makeVert = (md, mq) => {
                 vertices.push(cx + nx*hs + dx*hs*md + qx*hs*mq);
                 vertices.push(cy + ny*hs + dy*hs*md + qy*hs*mq);
                 vertices.push(cz + nz*hs + dz*hs*md + qz*hs*mq);
                 normals.push(nx, ny, nz);
                 
                 let ao = 1.0;
                 if (options.bakeAO) ao = getAO(cx, cy, cz, nx, ny, nz, dx*md, dy*md, qx*mq, qy*mq);
                 
                 if (!options.textureAtlas) colors.push(v.r * ao, v.g * ao, v.b * ao);
                 else uvs.push(uOffset, 0.5); 
             };

             makeVert(1, 1); makeVert(-1, 1); makeVert(-1, -1);
             makeVert(1, 1); makeVert(-1, -1); makeVert(1, -1);
          };

          let atlasCanvas, colorToU;
          if (options.textureAtlas) {
             const uniqueHex = [...new Set(processedVoxels.map(v => v.hex))];
             const width = uniqueHex.length;
             atlasCanvas = document.createElement('canvas');
             atlasCanvas.width = width;
             atlasCanvas.height = 1;
             const ctx = atlasCanvas.getContext('2d');
             colorToU = {};
             uniqueHex.forEach((hex, i) => {
                ctx.fillStyle = '#' + hex;
                ctx.fillRect(i, 0, 1, 1);
                colorToU[hex] = (i + 0.5) / width;
             });
          }

          processedVoxels.forEach(v => {
              if (!voxelMap.has(\`\${v.x+scaleFactor},\${v.y},\${v.z}\`)) addFace(v, 'px', options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x-scaleFactor},\${v.y},\${v.z}\`)) addFace(v, 'nx', options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y+scaleFactor},\${v.z}\`)) addFace(v, 'py', options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y-scaleFactor},\${v.z}\`)) addFace(v, 'ny', options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y},\${v.z+scaleFactor}\`)) addFace(v, 'pz', options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y},\${v.z-scaleFactor}\`)) addFace(v, 'nz', options.textureAtlas ? colorToU[v.hex] : 0);
          });

          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
          geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
          if (options.textureAtlas) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
          else geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

          if (format === 'GLTF') {
             const exportScene = new THREE.Scene();
             let material;
             if (options.textureAtlas) {
                 const tex = new THREE.CanvasTexture(atlasCanvas);
                 tex.magFilter = THREE.NearestFilter;
                 tex.minFilter = THREE.NearestFilter;
                 tex.colorSpace = THREE.SRGBColorSpace;
                 material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
             } else {
                 material = new THREE.MeshStandardMaterial({ vertexColors: !options.textureAtlas, roughness: 0.8 });
             }
             const mesh = new THREE.Mesh(geometry, material);
             exportScene.add(mesh);
             const exporter = new GLTFExporter();
             exporter.parse(exportScene, (gltf) => {
                 const content = JSON.stringify(gltf);
                 window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'GLTF', content }, '*');
             }, { binary: false });
          }

          if (format === 'OBJ') {
            let obj = "# Voxel Forge Optimized Export\\n";
            for (let i = 0; i < vertices.length; i+=3) obj += \`v \${vertices[i]} \${vertices[i+1]} \${vertices[i+2]}\\n\`;
            for (let i = 0; i < normals.length; i+=3) obj += \`vn \${normals[i]} \${normals[i+1]} \${normals[i+2]}\\n\`;
            const count = vertices.length / 3;
            for (let i = 0; i < count; i+=3) {
               const i1 = i + 1; const i2 = i + 2; const i3 = i + 3;
               obj += \`f \${i1}//\${i1} \${i2}//\${i2} \${i3}//\${i3}\\n\`;
            }
            window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'OBJ', content: obj }, '*');
          }
        }
      });
    </script>
  `;
  return injectIntoHead(html, bridgeScript);
};

/**
 * Injects Interaction Bridge for Raycasting, Painting, Erasing, and Adding voxels.
 * UPDATED: Includes Tool Visual Feedback and Improved Granular History.
 */
export const injectInteractionBridge = (html: string): string => {
  const script = `
    <script>
      (function() {
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        let currentTool = 'view';
        let currentColor = new THREE.Color('#ff0000');
        let currentGlow = false;
        
        let userMesh;
        let userCount = 0;
        const MAX_USER_VOXELS = 10000;

        let hoverVoxel;

        function initHoverVoxel() {
          if (hoverVoxel) return;
          const geo = new THREE.BoxGeometry(1.05, 1.05, 1.05);
          const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, wireframe: true });
          hoverVoxel = new THREE.Mesh(geo, mat);
          hoverVoxel.visible = false;
          scene.add(hoverVoxel);
        }

        function initUserLayer() {
           if (userMesh) return;
           if (typeof THREE === 'undefined' || typeof scene === 'undefined') return;
           const geo = new THREE.BoxGeometry(1, 1, 1);
           const mat = new THREE.MeshStandardMaterial({ 
             color: 0xffffff, 
             roughness: 0.8,
             emissive: 0x000000,
             emissiveIntensity: 0
           });
           userMesh = new THREE.InstancedMesh(geo, mat, MAX_USER_VOXELS);
           userMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
           userMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_USER_VOXELS * 3), 3);
           userMesh.name = "UserLayer";
           const dummy = new THREE.Object3D();
           dummy.scale.set(0,0,0);
           dummy.updateMatrix();
           for(let i=0; i<MAX_USER_VOXELS; i++) userMesh.setMatrixAt(i, dummy.matrix);
           userMesh.instanceMatrix.needsUpdate = true;
           scene.add(userMesh);
        }

        const history = [];
        let historyIndex = -1;

        function notifyParent() {
          window.parent.postMessage({
            type: 'HISTORY_STATUS',
            canUndo: historyIndex >= 0,
            canRedo: historyIndex < history.length - 1
          }, '*');
        }

        function recordAction(action) {
           if (historyIndex < history.length - 1) history.splice(historyIndex + 1);
           history.push(action);
           historyIndex++;
           notifyParent();
        }

        function applyEdit(action, isUndo) {
           const mesh = action.mesh; 
           const idx = action.index;
           if (action.type === 'paint') {
             const col = isUndo ? action.oldColor : action.newColor;
             mesh.setColorAt(idx, new THREE.Color(col));
             if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
           }
           else if (action.type === 'erase') {
             const matArr = isUndo ? action.oldMatrix : action.newMatrix;
             mesh.setMatrixAt(idx, new THREE.Matrix4().fromArray(matArr));
             mesh.instanceMatrix.needsUpdate = true;
           }
           else if (action.type === 'add') {
             const m = new THREE.Matrix4().fromArray(action.matrix);
             if (isUndo) {
                const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
                m.decompose(p, q, s); s.set(0,0,0); m.compose(p, q, s);
                mesh.setMatrixAt(idx, m);
             } else {
                mesh.setMatrixAt(idx, m);
             }
             mesh.instanceMatrix.needsUpdate = true;
           }
        }

        window.addEventListener('message', (e) => {
          if (e.data.type === 'SET_TOOL') {
            currentTool = e.data.tool;
            if (currentTool !== 'view' && typeof controls !== 'undefined') controls.autoRotate = false;
            if (currentTool === 'add') initUserLayer();
            if (currentTool !== 'view') initHoverVoxel();
            if (hoverVoxel) hoverVoxel.visible = false;
          }
          if (e.data.type === 'SET_COLOR') {
            currentColor.set(e.data.color);
            currentGlow = e.data.glow;
            if (currentGlow && userMesh) {
               userMesh.material.emissive.set(0xffffff);
               userMesh.material.emissiveIntensity = 1.0;
            }
          }
          if (e.data.type === 'UNDO_EDIT') {
             if (historyIndex >= 0) {
               applyEdit(history[historyIndex], true);
               historyIndex--;
               notifyParent();
             }
          }
          if (e.data.type === 'REDO_EDIT') {
             if (historyIndex < history.length - 1) {
               historyIndex++;
               applyEdit(history[historyIndex], false);
               notifyParent();
             }
          }
        });

        window.addEventListener('pointermove', (event) => {
          if (currentTool === 'view' || !hoverVoxel) return;
          pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
          pointer.y = - (event.clientY / window.innerHeight) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const intersects = raycaster.intersectObjects(scene.children, true);
          if (intersects.length > 0) {
            const hit = intersects.find(i => i.object.isInstancedMesh);
            if (hit) {
              const mesh = hit.object;
              const instanceId = hit.instanceId;
              const matrix = new THREE.Matrix4();
              mesh.getMatrixAt(instanceId, matrix);
              const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
              
              if (currentTool === 'add') {
                pos.add(hit.face.normal);
              }
              
              hoverVoxel.position.copy(pos);
              hoverVoxel.visible = true;
            } else {
              hoverVoxel.visible = false;
            }
          } else {
            hoverVoxel.visible = false;
          }
        });

        window.addEventListener('pointerdown', (event) => {
          if (currentTool === 'view') return;
          if (typeof camera === 'undefined' || typeof scene === 'undefined') return;
          pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
          pointer.y = - (event.clientY / window.innerHeight) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const intersects = raycaster.intersectObjects(scene.children, true);
          if (intersects.length > 0) {
            const hit = intersects.find(i => i.object.isInstancedMesh);
            if (hit) {
              const mesh = hit.object;
              const instanceId = hit.instanceId;
              if (currentTool === 'pick') {
                 const col = new THREE.Color();
                 mesh.getColorAt(instanceId, col);
                 window.parent.postMessage({ type: 'PICK_COLOR', color: '#' + col.getHexString() }, '*');
                 return;
              }
              if (currentTool === 'add') {
                 if (!userMesh) initUserLayer();
                 if (userCount >= MAX_USER_VOXELS) return;
                 const matrix = new THREE.Matrix4();
                 mesh.getMatrixAt(instanceId, matrix);
                 const pos = new THREE.Vector3();
                 matrix.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
                 pos.add(hit.face.normal);
                 const dummy = new THREE.Object3D();
                 dummy.position.copy(pos);
                 dummy.updateMatrix();
                 const nextIdx = userCount;
                 userMesh.setMatrixAt(nextIdx, dummy.matrix);
                 userMesh.setColorAt(nextIdx, currentColor);
                 userMesh.instanceMatrix.needsUpdate = true;
                 if (userMesh.instanceColor) userMesh.instanceColor.needsUpdate = true;
                 userCount++;
                 recordAction({ type: 'add', mesh: userMesh, index: nextIdx, matrix: dummy.matrix.toArray() });
              }
              else if (currentTool === 'erase') {
                const oldMatrix = new THREE.Matrix4();
                mesh.getMatrixAt(instanceId, oldMatrix);
                const pos = new THREE.Vector3(); const rot = new THREE.Quaternion(); const scale = new THREE.Vector3();
                oldMatrix.decompose(pos, rot, scale); 
                if (scale.x < 0.1) return; // Already erased
                scale.set(0, 0, 0);
                const newMatrix = new THREE.Matrix4().compose(pos, rot, scale);
                mesh.setMatrixAt(instanceId, newMatrix);
                mesh.instanceMatrix.needsUpdate = true;
                recordAction({ type: 'erase', mesh: mesh, index: instanceId, oldMatrix: oldMatrix.toArray(), newMatrix: newMatrix.toArray() });
              } 
              else if (currentTool === 'paint') {
                const oldColor = new THREE.Color();
                mesh.getColorAt(instanceId, oldColor);
                if (oldColor.getHex() !== currentColor.getHex()) {
                    mesh.setColorAt(instanceId, currentColor.clone());
                    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
                    recordAction({ type: 'paint', mesh: mesh, index: instanceId, oldColor: '#' + oldColor.getHexString(), newColor: '#' + currentColor.getHexString() });
                }
              }
            }
          }
        });
      })();
    </script>
  `;
  return injectIntoHead(html, script);
}

/**
 * Injects a cellular-automata based physics system into the sandbox.
 */
export const injectVoxelPhysics = (html: string): string => {
  const script = `
    <script>
      (function() {
        let physicsEnabled = false, voxels = [], originalState = [], grid = new Map();
        const STEP = 0.05, GRAV = -0.98;
        window.addEventListener('message', (e) => {
          if (e.data.type === 'TOGGLE_PHYSICS') {
            physicsEnabled = e.data.enabled;
            scene?.traverse(obj => {
              if ((obj.isMesh || obj.isInstancedMesh) && obj.material) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach(mat => {
                  if (physicsEnabled) {
                    if (mat._origOpacity === undefined) { mat._origOpacity = mat.opacity; mat._origTransparent = mat.transparent; }
                    mat.transparent = true; mat.opacity = 0.8;
                  } else if (mat._origOpacity !== undefined) { mat.opacity = mat._origOpacity; mat.transparent = mat._origTransparent; }
                });
              }
            });
            if (physicsEnabled && !voxels.length) init();
          }
          if (e.data.type === 'RESET_PHYSICS') reset();
        });
        const key = (x, y, z) => \`\${Math.round(x)},\${Math.round(y)},\${Math.round(z)}\`;
        function init() {
          voxels = []; grid.clear();
          scene?.traverse(obj => {
            if (obj.isInstancedMesh) {
              const m = new THREE.Matrix4();
              for (let i = 0; i < obj.count; i++) {
                obj.getMatrixAt(i, m);
                const pos = new THREE.Vector3().setFromMatrixPosition(m);
                const s = new THREE.Vector3(); m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
                if (s.x < 0.1) continue;
                originalState.push({ mesh: obj, idx: i, matrix: m.clone() });
                voxels.push({ mesh: obj, idx: i, pos: pos.clone(), vel: new THREE.Vector3(), static: pos.y <= 0.5 });
                grid.set(key(pos.x, pos.y, pos.z), true);
              }
            }
          });
        }
        function reset() {
          originalState.forEach(s => { s.mesh.setMatrixAt(s.idx, s.matrix); s.mesh.instanceMatrix.needsUpdate = true; });
          init();
        }
        setInterval(() => {
          if (!physicsEnabled) return;
          grid.clear(); voxels.forEach(v => grid.set(key(v.pos.x, v.pos.y, v.pos.z), true));
          voxels.forEach(v => {
            if (v.static) return;
            if (!grid.has(key(v.pos.x, v.pos.y - 1, v.pos.z)) && v.pos.y > 0) v.vel.y += GRAV * STEP;
            else { v.vel.y = 0; v.pos.y = Math.round(v.pos.y); }
            v.pos.add(v.vel.clone().multiplyScalar(STEP));
            if (v.pos.y < 0) { v.pos.y = 0; v.vel.y = 0; }
            const m = new THREE.Matrix4(); v.mesh.getMatrixAt(v.idx, m); m.setPosition(v.pos);
            v.mesh.setMatrixAt(v.idx, m); v.mesh.instanceMatrix.needsUpdate = true;
          });
        }, 16);
      })();
    </script>
  `;
  return injectIntoHead(html, script);
};

/**
 * Injects CSS animations and JS-based vertical oscillation.
 */
export const injectSubtleAnimation = (html: string): string => {
  const code = `
    <style>
      @keyframes voxelEntrance { 0% { opacity: 0; transform: scale(0.98) translateY(10px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
      canvas { animation: voxelEntrance 1.2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards; }
    </style>
    <script>
      (function() {
        const start = Date.now();
        const hook = setInterval(() => {
          if (window.THREE && window.THREE.WebGLRenderer) {
            clearInterval(hook);
            const render = THREE.WebGLRenderer.prototype.render;
            THREE.WebGLRenderer.prototype.render = function(s, c) {
              if (s && !s._f) { s._f = true; s._y = s.position.y; }
              const hovering = document.querySelector('canvas:hover');
              if (s && !window._physicsActive && !hovering) s.position.y = (s._y || 0) + Math.sin((Date.now() - start) * 0.0015) * 0.4;
              render.call(this, s, c);
            };
          }
        }, 100);
      })();
    </script>
  `;
  return injectIntoHead(html, code);
};

/**
 * Programmatically updates the camera position.
 */
export const setCameraView = (html: string, pos: {x: number, y: number, z: number}): string => {
  const setRe = /camera\.position\.set\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)/g;
  let up = html.replace(setRe, `camera.position.set(${pos.x}, ${pos.y}, ${pos.z})`);
  ['x', 'y', 'z'].forEach(k => {
    const re = new RegExp(`camera\\.position\\.${k}\\s*=\\s*(-?\\d*\\.?\\d+)`, 'g');
    up = up.replace(re, `camera.position.${k} = ${pos[k as keyof typeof pos]}`);
  });
  if (!up.includes('camera.lookAt(0, 0, 0)')) up = up.replace(/renderer\.render/g, `camera.lookAt(0, 0, 0); renderer.render`);
  return up;
};

/**
 * Dynamically modifies scene parameters like Fog, Background, and Lighting.
 * UPDATED: Optimized regex for faster injection.
 */
export const updateSceneParameters = (
  html: string, 
  p: { backgroundColor: string, autoRotate: boolean, lightIntensity: number, fogDensity: number }
): string => {
  const bgRe = /scene\.background\s*=\s*new\s*THREE\.Color\s*\([^)]+\)/gi;
  let up = html.replace(bgRe, `scene.background = new THREE.Color('${p.backgroundColor}')`);
  const rotRe = /controls\.autoRotate\s*=\s*(true|false)/gi;
  up = rotRe.test(up) ? up.replace(rotRe, `controls.autoRotate = ${p.autoRotate}`) : up.replace(/controls\.update\(\)/g, `controls.autoRotate = ${p.autoRotate}; controls.update()`);
  
  // Handle lighting intensity updates
  const lRe = /(AmbientLight|DirectionalLight|PointLight|SpotLight)\s*\(\s*([^,]+)\s*,\s*(-?\d*\.?\d+)\s*\)/gi;
  up = up.replace(lRe, (m: any, t: any, c: any, ...args: any[]) => `${t}(${c}, ${p.lightIntensity})`);
  
  // Handle fog changes with explicit arguments to handle multiple capturing groups correctly in TypeScript
  const fRe = /new\s*THREE\.(Fog|FogExp2)\s*\(\s*([^,]+)\s*,\s*(-?\\d*\\.?\\d+)([^)]*)\)/gi;
  up = up.replace(fRe, (m: any, t: any, c: any, ...args: any[]) => t === 'FogExp2' ? `new THREE.FogExp2(${c}, ${p.fogDensity / 40})` : `new THREE.Fog(${c}, 1, ${100 / (p.fogDensity || 0.01)})`);
  
  // Fix: The original code was missing backticks around the style tag, which caused TSX syntax errors
  return injectIntoHead(up, `<style>body { background-color: ${p.backgroundColor} !important; }</style>`);
};

/**
 * Injects content into the head tag or prepends if not found.
 */
const injectIntoHead = (html: string, content: string): string => {
  if (html.toLowerCase().includes('</head>')) {
    return html.replace(/<\/head>/i, `${content}</head>`);
  }
  return content + html;
};
