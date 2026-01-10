
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
 * UPDATED: Filters out "deleted" voxels (scale ~ 0).
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
          const voxels = [];
          if (typeof scene !== 'undefined') {
            scene.traverse((obj) => {
              if (obj.isInstancedMesh) {
                const matrix = new THREE.Matrix4();
                const color = new THREE.Color();
                const scale = new THREE.Vector3();
                const pos = new THREE.Vector3();
                
                for (let i = 0; i < obj.count; i++) {
                  obj.getMatrixAt(i, matrix);
                  matrix.decompose(pos, new THREE.Quaternion(), scale);
                  
                  // Skip deleted voxels (scale roughly 0)
                  if (scale.x < 0.1) continue;

                  obj.getColorAt(i, color);
                  voxels.push({ 
                    x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), 
                    r: Math.floor(color.r * 255), g: Math.floor(color.g * 255), b: Math.floor(color.b * 255),
                    hex: "#" + color.getHexString()
                  });
                }
              }
            });
          }

          if (format === 'GLTF') {
            // Create a temporary scene for clean export
            const exportScene = new THREE.Scene();
            const group = new THREE.Group();
            exportScene.add(group);

            if (options.optimize) {
              // Greedy Meshing Logic (Simple Version)
              const colorGroups = {};
              voxels.forEach(v => {
                if (!colorGroups[v.hex]) colorGroups[v.hex] = [];
                colorGroups[v.hex].push(v);
              });

              Object.keys(colorGroups).forEach(hex => {
                const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex) });
                colorGroups[hex].forEach(v => {
                  const geo = new THREE.BoxGeometry(1, 1, 1);
                  const mesh = new THREE.Mesh(geo, mat);
                  mesh.position.set(v.x, v.y, v.z);
                  group.add(mesh);
                });
              });
            } else {
              // Raw export
              voxels.forEach(v => {
                const geo = new THREE.BoxGeometry(1, 1, 1);
                const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(v.hex) });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(v.x, v.y, v.z);
                group.add(mesh);
              });
            }

            const exporter = new GLTFExporter();
            exporter.parse(exportScene, (gltf) => {
              const content = JSON.stringify(gltf);
              window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'GLTF', content }, '*');
            }, { binary: false });
            return;
          }

          if (format === 'OBJ') {
            let obj = "# Voxel Forge Advanced Export\\n";
            voxels.forEach((v, i) => {
              const off = i * 8; const s = 0.5;
              obj += \`v \${v.x-s} \${v.y-s} \${v.z+s}\\nv \${v.x+s} \${v.y-s} \${v.z+s}\\nv \${v.x+s} \${v.y+s} \${v.z+s}\\nv \${v.x-s} \${v.y+s} \${v.z+s}\\nv \${v.x-s} \${v.y-s} \${v.z-s}\\nv \${v.x+s} \${v.y-s} \${v.z-s}\\nv \${v.x+s} \${v.y+s} \${v.z-s}\\nv \${v.x-s} \${v.y+s} \${v.z-s}\\n\`;
              obj += \`f \${off+1} \${off+2} \${off+3} \${off+4}\\nf \${off+8} \${off+7} \${off+6} \${off+5}\\nf \${off+1} \${off+4} \${off+8} \${off+5}\\nf \${off+2} \${off+1} \${off+5} \${off+6}\\nf \${off+3} \${off+2} \${off+6} \${off+7}\\nf \${off+4} \${off+3} \${off+7} \${off+8}\\n\`;
            });
            window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'OBJ', content: obj }, '*');
          } else if (format === 'VOX') {
            window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'VOX', content: JSON.stringify(voxels) }, '*');
          }
        }
      });
    </script>
  `;
  return injectIntoHead(html, bridgeScript);
};

/**
 * Injects Interaction Bridge for Raycasting, Painting, and Erasing voxels.
 * UPDATED: Includes Undo/Redo Stack
 */
export const injectInteractionBridge = (html: string): string => {
  const script = `
    <script>
      (function() {
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        let currentTool = 'view'; // view, paint, erase
        let currentColor = new THREE.Color('#ff0000');
        
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
           // Remove any future actions if we are branching
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
        }

        window.addEventListener('message', (e) => {
          if (e.data.type === 'SET_TOOL') {
            currentTool = e.data.tool;
            if (currentTool !== 'view' && typeof controls !== 'undefined') {
               controls.autoRotate = false;
            }
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

          // Calculate pointer position in normalized device coordinates
          pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
          pointer.y = - (event.clientY / window.innerHeight) * 2 + 1;

          raycaster.setFromCamera(pointer, camera);

          const intersects = raycaster.intersectObjects(scene.children, true);

          if (intersects.length > 0) {
            // Find the first instanced mesh intersection
            const hit = intersects.find(i => i.object.isInstancedMesh);
            
            if (hit) {
              const mesh = hit.object;
              const instanceId = hit.instanceId;
              
              if (currentTool === 'erase') {
                const oldMatrix = new THREE.Matrix4();
                mesh.getMatrixAt(instanceId, oldMatrix);
                
                // Calculate new matrix (scale 0 to hide)
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
