
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
  // Search for full document or just <html> tag
  const htmlMatch = text.match(/(<!DOCTYPE html>|<html)[\s\S]*?<\/html>/i);
  if (htmlMatch) return htmlMatch[0];
  // Fallback to code block content
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
 * Includes a Greedy Meshing engine for mesh optimization (LOD).
 * UPDATED: Implements Face Culling, LOD Downsampling, and Texture Atlas Baking.
 */
export const injectExporterBridge = (html: string): string => {
  const bridgeScript = `
    <script type="module">
      import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

      window.addEventListener('message', async (event) => {
        if (!event.data) return;

        const { type, format, options = {} } = event.data;

        if (type === 'GET_SNAPSHOT' && typeof renderer !== 'undefined') {
          if (typeof scene !== 'undefined' && typeof camera !== 'undefined') renderer.render(scene, camera);
          const dataUrl = renderer.domElement.toDataURL('image/webp', 0.8);
          window.parent.postMessage({ type: 'SNAPSHOT_RESULT', dataUrl }, '*');
        }

        if (type === 'EXPORT_SCENE') {
          // --- 1. Gather Raw Voxels ---
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
                  
                  // Skip hidden/deleted voxels
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

          // --- 2. Apply LOD (Downsampling) ---
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
                cell.r += v.r; cell.g += v.g; cell.b += v.b;
                cell.count++;
             });

             processedVoxels = Array.from(grid.values()).map(v => ({
                x: v.x * scaleFactor, y: v.y * scaleFactor, z: v.z * scaleFactor,
                r: v.r / v.count, g: v.g / v.count, b: v.b / v.count,
                hex: new THREE.Color(v.r/v.count, v.g/v.count, v.b/v.count).getHexString()
             }));
          }

          if (format === 'VOX') {
             // VOX doesn't support custom geometry easily, just return list
             window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'VOX', content: JSON.stringify(processedVoxels) }, '*');
             return;
          }

          // --- 3. Face Culling & Geometry Generation ---
          // Map for fast lookups
          const voxelMap = new Map();
          const voxelSize = 1 * scaleFactor;
          processedVoxels.forEach(v => voxelMap.set(\`\${v.x},\${v.y},\${v.z}\`, v));

          const vertices = [];
          const normals = [];
          const colors = [];
          const uvs = [];

          // Helper to add face
          const addFace = (v, dir, w, h, d, uOffset, uScale) => {
             // Standard box face vertices logic
             // .. simplified for brevity, using offset directions
             let nx=0, ny=0, nz=0;
             let dx=0, dy=0, dz=0; // tangent 1
             let qx=0, qy=0, qz=0; // tangent 2
             
             // Half size
             const hs = voxelSize / 2;
             const cx = v.x, cy = v.y, cz = v.z; // Center is usually voxel coord if integer

             // Define vertices relative to center
             if (dir === 'px') { nx=1; dx=0; dy=0; dz=-1; qx=0; qy=-1; qz=0; } // Right
             if (dir === 'nx') { nx=-1; dx=0; dy=0; dz=1; qx=0; qy=-1; qz=0; } // Left
             if (dir === 'py') { ny=1; dx=1; dy=0; dz=0; qx=0; qy=0; qz=1; } // Top
             if (dir === 'ny') { ny=-1; dx=1; dy=0; dz=0; qx=0; qy=0; qz=-1; } // Bottom
             if (dir === 'pz') { nz=1; dx=1; dy=0; dz=0; qx=0; qy=-1; qz=0; } // Front
             if (dir === 'nz') { nz=-1; dx=-1; dy=0; dz=0; qx=0; qy=-1; qz=0; } // Back

             // 4 Corners of the face
             // 0: +d -q, 1: -d -q, 2: -d +q, 3: +d +q  (Quad sequence)
             // Using triangles: 0,1,2 and 0,2,3
             
             // Simple quad generation
             const makeVert = (md, mq) => {
                 vertices.push(cx + nx*hs + dx*hs*md + qx*hs*mq);
                 vertices.push(cy + ny*hs + dy*hs*md + qy*hs*mq);
                 vertices.push(cz + nz*hs + dz*hs*md + qz*hs*mq);
                 normals.push(nx, ny, nz);
                 if (!options.textureAtlas) {
                    colors.push(v.r, v.g, v.b);
                 } else {
                    // UV mapping for atlas
                    // uOffset is the center u of the color
                    // we map face to a pixel in the strip
                    uvs.push(uOffset, 0.5); 
                 }
             };

             // Two triangles
             makeVert(1, 1); makeVert(-1, 1); makeVert(-1, -1);
             makeVert(1, 1); makeVert(-1, -1); makeVert(1, -1);
          };

          // Texture Atlas Prep
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
                // Center of pixel UV
                colorToU[hex] = (i + 0.5) / width;
             });
          }

          // Build Mesh Data
          processedVoxels.forEach(v => {
              // Neighbor checks
              if (!voxelMap.has(\`\${v.x+scaleFactor},\${v.y},\${v.z}\`)) addFace(v, 'px', 0,0,0, options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x-scaleFactor},\${v.y},\${v.z}\`)) addFace(v, 'nx', 0,0,0, options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y+scaleFactor},\${v.z}\`)) addFace(v, 'py', 0,0,0, options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y-scaleFactor},\${v.z}\`)) addFace(v, 'ny', 0,0,0, options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y},\${v.z+scaleFactor}\`)) addFace(v, 'pz', 0,0,0, options.textureAtlas ? colorToU[v.hex] : 0);
              if (!voxelMap.has(\`\${v.x},\${v.y},\${v.z-scaleFactor}\`)) addFace(v, 'nz', 0,0,0, options.textureAtlas ? colorToU[v.hex] : 0);
          });

          // Create Geometry
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
          geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
          if (options.textureAtlas) {
             geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
          } else {
             geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
          }

          // --- 4. Export Formats ---

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
                 material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
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
            // Manual Optimized OBJ generation
            let obj = "# Voxel Forge Optimized Export\\n";
            // Write Vertices
            for (let i = 0; i < vertices.length; i+=3) {
               obj += \`v \${vertices[i]} \${vertices[i+1]} \${vertices[i+2]}\\n\`;
            }
            // Write Normals
            for (let i = 0; i < normals.length; i+=3) {
               obj += \`vn \${normals[i]} \${normals[i+1]} \${normals[i+2]}\\n\`;
            }
            // Write Faces
            // OBJ indices are 1-based
            const count = vertices.length / 3;
            for (let i = 0; i < count; i+=3) {
               // f v/vt/vn
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
 * UPDATED: Includes 'add' (Build) and 'pick' (Pipette) tools.
 */
export const injectInteractionBridge = (html: string): string => {
  const script = `
    <script>
      (function() {
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        let currentTool = 'view'; // view, paint, erase, add, pick
        let currentColor = new THREE.Color('#ff0000');
        
        // --- User Edits Layer ---
        let userMesh;
        let userCount = 0;
        const MAX_USER_VOXELS = 10000;

        function initUserLayer() {
           if (userMesh) return;
           if (typeof THREE === 'undefined' || typeof scene === 'undefined') return;
           
           // Default to 1x1x1 geometry and standard material
           const geo = new THREE.BoxGeometry(1, 1, 1);
           const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
           userMesh = new THREE.InstancedMesh(geo, mat, MAX_USER_VOXELS);
           userMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
           userMesh.name = "UserLayer";
           
           // Initialize all scales to 0 to hide them
           const dummy = new THREE.Object3D();
           dummy.scale.set(0,0,0);
           dummy.updateMatrix();
           for(let i=0; i<MAX_USER_VOXELS; i++) {
              userMesh.setMatrixAt(i, dummy.matrix);
           }
           userMesh.instanceMatrix.needsUpdate = true;
           scene.add(userMesh);
        }

        // --- History System ---
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
           if (historyIndex < history.length - 1) {
             history.splice(historyIndex + 1);
           }
           history.push(action);
           historyIndex++;
           notifyParent();
        }

        function applyEdit(action, isUndo) {
           const mesh = action.mesh; 
           const idx = action.index;
           
           if (action.type === 'paint') {
             const col = isUndo ? action.oldColor : action.newColor;
             const c = new THREE.Color(col);
             mesh.setColorAt(idx, c);
             if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
           }
           else if (action.type === 'erase') {
             const matArr = isUndo ? action.oldMatrix : action.newMatrix;
             const m = new THREE.Matrix4().fromArray(matArr);
             mesh.setMatrixAt(idx, m);
             mesh.instanceMatrix.needsUpdate = true;
           }
           else if (action.type === 'add') {
             // Undo add = hide (scale 0), Redo add = show (restore matrix)
             const m = new THREE.Matrix4();
             if (isUndo) {
                // Scale to 0
                m.fromArray(action.matrix);
                const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
                m.decompose(p, q, s);
                s.set(0,0,0);
                m.compose(p, q, s);
             } else {
                // Restore original matrix
                m.fromArray(action.matrix);
             }
             mesh.setMatrixAt(idx, m);
             mesh.instanceMatrix.needsUpdate = true;
             
             // Restore color logic
             // Note: UserMesh colors are set once, we don't strictly need to unset color on undo, just hide geometry
           }
        }

        window.addEventListener('message', (e) => {
          if (e.data.type === 'SET_TOOL') {
            currentTool = e.data.tool;
            if (currentTool !== 'view' && typeof controls !== 'undefined') {
               controls.autoRotate = false;
            }
            if (currentTool === 'add') initUserLayer();
          }
          if (e.data.type === 'SET_COLOR') {
            currentColor.set(e.data.color);
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

        window.addEventListener('pointerdown', (event) => {
          if (currentTool === 'view') return;
          if (typeof camera === 'undefined' || typeof scene === 'undefined') return;

          pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
          pointer.y = - (event.clientY / window.innerHeight) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);

          // Intersect everything including user mesh
          const intersects = raycaster.intersectObjects(scene.children, true);
          
          if (intersects.length > 0) {
            const hit = intersects.find(i => i.object.isInstancedMesh);
            
            if (hit) {
              const mesh = hit.object;
              const instanceId = hit.instanceId;

              if (currentTool === 'pick') {
                 const col = new THREE.Color();
                 mesh.getColorAt(instanceId, col);
                 window.parent.postMessage({
                    type: 'PICK_COLOR',
                    color: '#' + col.getHexString()
                 }, '*');
                 return;
              }

              if (currentTool === 'add') {
                 if (!userMesh) initUserLayer();
                 if (userCount >= MAX_USER_VOXELS) return; // Limit reached

                 // Calculate new position based on face normal
                 // Snap to nearest integer grid assuming size 1
                 // Note: hit.face.normal is in object space. For standard axis-aligned voxels, this is fine.
                 
                 const matrix = new THREE.Matrix4();
                 mesh.getMatrixAt(instanceId, matrix);
                 const pos = new THREE.Vector3();
                 matrix.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
                 
                 // Apply normal
                 const n = hit.face.normal.clone();
                 // If the hit object is rotated, we might need to transform normal. 
                 // Assuming standard world alignment for simplicity or baking.
                 
                 pos.add(n);
                 
                 // Place user voxel
                 const dummy = new THREE.Object3D();
                 dummy.position.copy(pos);
                 dummy.updateMatrix();
                 
                 const nextIdx = userCount;
                 userMesh.setMatrixAt(nextIdx, dummy.matrix);
                 userMesh.setColorAt(nextIdx, currentColor);
                 userMesh.instanceMatrix.needsUpdate = true;
                 if (userMesh.instanceColor) userMesh.instanceColor.needsUpdate = true;
                 
                 userCount++;

                 recordAction({
                    type: 'add',
                    mesh: userMesh,
                    index: nextIdx,
                    matrix: dummy.matrix.toArray()
                 });
              }
              else if (currentTool === 'erase') {
                const oldMatrix = new THREE.Matrix4();
                mesh.getMatrixAt(instanceId, oldMatrix);
                
                const pos = new THREE.Vector3();
                const rot = new THREE.Quaternion();
                const scale = new THREE.Vector3();
                oldMatrix.decompose(pos, rot, scale);
                scale.set(0, 0, 0);
                const newMatrix = new THREE.Matrix4().compose(pos, rot, scale);
                
                mesh.setMatrixAt(instanceId, newMatrix);
                mesh.instanceMatrix.needsUpdate = true;

                recordAction({
                  type: 'erase',
                  mesh: mesh,
                  index: instanceId,
                  oldMatrix: oldMatrix.toArray(),
                  newMatrix: newMatrix.toArray()
                });
              } 
              else if (currentTool === 'paint') {
                const oldColor = new THREE.Color();
                mesh.getColorAt(instanceId, oldColor);
                const newColor = currentColor.clone();

                if (oldColor.getHex() !== newColor.getHex()) {
                    mesh.setColorAt(instanceId, newColor);
                    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

                    recordAction({
                      type: 'paint',
                      mesh: mesh,
                      index: instanceId,
                      oldColor: '#' + oldColor.getHexString(),
                      newColor: '#' + newColor.getHexString()
                    });
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
                    if (mat._origOpacity === undefined) {
                      mat._origOpacity = mat.opacity;
                      mat._origTransparent = mat.transparent;
                    }
                    mat.transparent = true;
                    mat.opacity = 0.8;
                  } else {
                    if (mat._origOpacity !== undefined) {
                      mat.opacity = mat._origOpacity;
                      mat.transparent = mat._origTransparent;
                    }
                  }
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
                
                // Skip deleted voxels
                const s = new THREE.Vector3();
                m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
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
          grid.clear();
          voxels.forEach(v => grid.set(key(v.pos.x, v.pos.y, v.pos.z), true));
          voxels.forEach(v => {
            if (v.static) return;
            if (!grid.has(key(v.pos.x, v.pos.y - 1, v.pos.z)) && v.pos.y > 0) {
              v.vel.y += GRAV * STEP;
            } else {
              v.vel.y = 0; v.pos.y = Math.round(v.pos.y);
            }
            v.pos.add(v.vel.clone().multiplyScalar(STEP));
            if (v.pos.y < 0) { v.pos.y = 0; v.vel.y = 0; }
            const m = new THREE.Matrix4();
            v.mesh.getMatrixAt(v.idx, m); m.setPosition(v.pos);
            v.mesh.setMatrixAt(v.idx, m); v.mesh.instanceMatrix.needsUpdate = true;
          });
        }, 16);
      })();
    </script>
  `;
  return injectIntoHead(html, script);
};

/**
 * Injects CSS animations for scene entrance and a JS-based vertical oscillation effect.
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
              // Skip animation if mouse is interacting (to prevent jitter while painting)
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
 * Programmatically updates the camera position in the sandbox.
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
 */
export const updateSceneParameters = (
  html: string, 
  p: { backgroundColor: string, autoRotate: boolean, lightIntensity: number, fogDensity: number }
): string => {
  const bgRe = /scene\.background\s*=\s*new\s*THREE\.Color\s*\([^)]+\)/gi;
  let up = html.replace(bgRe, `scene.background = new THREE.Color('${p.backgroundColor}')`);
  
  const rotRe = /controls\.autoRotate\s*=\s*(true|false)/gi;
  up = rotRe.test(up) ? up.replace(rotRe, `controls.autoRotate = ${p.autoRotate}`) : up.replace(/controls\.update\(\)/g, `controls.autoRotate = ${p.autoRotate}; controls.update()`);
  
  const lRe = /(AmbientLight|DirectionalLight|PointLight|SpotLight)\s*\(\s*([^,]+)\s*,\s*(-?\d*\.?\d+)\s*\)/gi;
  up = up.replace(lRe, (m, t, c, i) => `${t}(${c}, ${p.lightIntensity})`);
  
  const fRe = /new\s*THREE\.(Fog|FogExp2)\s*\(\s*([^,]+)\s*,\s*(-?\d*\.?\d+)([^)]*)\)/gi;
  up = up.replace(fRe, (m, t, c, d) => t === 'FogExp2' ? `new THREE.FogExp2(${c}, ${p.fogDensity / 50})` : `new THREE.Fog(${c}, 10, ${100 / (p.fogDensity || 0.1)})`);
  
  return injectIntoHead(up, `<style>body { background-color: ${p.backgroundColor} !important; }</style>`);
};

/**
 * Helper to inject strings into the <head> of an HTML document.
 */
const injectIntoHead = (html: string, content: string): string => {
  return html.toLowerCase().includes('</head>') ? html.replace(/<\/head>/i, `${content}</head>`) : content + html;
};
