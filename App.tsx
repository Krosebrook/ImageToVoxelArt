
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { generateImage, generateVoxelScene } from './services/gemini';
import { 
  extractHtmlFromText, 
  hideBodyText, 
  setCameraView, 
  injectSubtleAnimation, 
  updateSceneParameters,
  injectExporterBridge
} from './utils/html';

type AppStatus = 'idle' | 'generating_image' | 'generating_voxels' | 'error' | 'saving';
type VoxelStyle = 'Classic' | 'Micro' | 'Low Poly' | 'Cyberpunk';
type InspectorTab = 'transform' | 'atmosphere' | 'export';

interface UserContent {
  image: string;
  voxel: string | null;
  prompt: string;
  palette: string[];
  backgroundColor: string;
  autoRotate: boolean;
  lightIntensity: number;
  fogDensity: number;
  style: VoxelStyle;
}

interface SavedScene extends UserContent {
  id: string;
  timestamp: number;
  thumbnail: string; // Captured 3D snapshot or source image
}

const STORAGE_KEY = 'voxel_forge_vault_v5';
const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];
const STYLES: VoxelStyle[] = ['Classic', 'Micro', 'Low Poly', 'Cyberpunk'];

const SAMPLE_PROMPTS = [
  "A tree house under the sea",
  "A cyberpunk street food stall", 
  "An ancient temple floating in the sky",
  "A cozy winter cabin with smoke",
  "A futuristic mars rover",
  "A dragon guarding gold"
];

const EXAMPLES = [
  { img: 'https://www.gstatic.com/aistudio/starter-apps/image_to_voxel/example1.png', id: 'ex1' },
  { img: 'https://www.gstatic.com/aistudio/starter-apps/image_to_voxel/example2.png', id: 'ex2' },
  { img: 'https://www.gstatic.com/aistudio/starter-apps/image_to_voxel/example3.png', id: 'ex3' },
];

const App: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [selectedTile, setSelectedTile] = useState<number | 'user' | string | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showRoadmap, setShowRoadmap] = useState(false);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'image' | 'voxel'>('image');
  const [activeTab, setActiveTab] = useState<InspectorTab>('transform');
  
  const [imageData, setImageData] = useState<string | null>(null);
  const [voxelCode, setVoxelCode] = useState<string | null>(null);
  const [palette, setPalette] = useState<string[]>(['#FF0000', '#00FF00', '#0000FF']);
  const [sceneBgColor, setSceneBgColor] = useState('#ffffff');
  const [autoRotate, setAutoRotate] = useState(true);
  const [lightIntensity, setLightIntensity] = useState(1.0);
  const [fogDensity, setFogDensity] = useState(0.5);
  const [voxelStyle, setVoxelStyle] = useState<VoxelStyle>('Classic');
  const [aspectRatio, setAspectRatio] = useState('1:1');

  const [history, setHistory] = useState<UserContent[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedScenes, setSavedScenes] = useState<SavedScene[]>([]);
  const [loadedThumbnails, setLoadedThumbnails] = useState<Record<string, string>>({});

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingSaveResolve = useRef<((dataUrl: string) => void) | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) try { setSavedScenes(JSON.parse(raw)); } catch (e) { localStorage.removeItem(STORAGE_KEY); }
    const interval = setInterval(() => setPlaceholderIndex(p => (p + 1) % SAMPLE_PROMPTS.length), 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedScenes)); } 
    catch (e) { 
      console.warn("Local storage full, capping gallery size.");
      if (savedScenes.length > 50) setSavedScenes(prev => prev.slice(0, 50)); 
    }
  }, [savedScenes]);

  useEffect(() => {
    const loadThumbnails = async () => {
      const loaded: Record<string, string> = {};
      await Promise.all(EXAMPLES.map(async (ex) => {
        try {
          const res = await fetch(ex.img);
          if (res.ok) loaded[ex.id] = URL.createObjectURL(await res.blob());
        } catch (e) { console.error(e); }
      }));
      setLoadedThumbnails(loaded);
    };
    loadThumbnails();
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data) return;

      if (event.data.type === 'SNAPSHOT_RESULT' && pendingSaveResolve.current) {
        pendingSaveResolve.current(event.data.dataUrl);
        pendingSaveResolve.current = null;
      }

      if (event.data.type === 'EXPORT_RESULT') {
        const { format, content } = event.data;
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `voxel_forge_export_${Date.now()}.${format.toLowerCase()}`;
        a.click();
        URL.revokeObjectURL(url);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (historyIndex >= 0 && historyIndex < history.length && selectedTile === 'user') {
      const s = history[historyIndex];
      setImageData(s.image);
      setVoxelCode(s.voxel);
      setPrompt(s.prompt);
      setPalette(s.palette);
      setSceneBgColor(s.backgroundColor);
      setAutoRotate(s.autoRotate);
      setLightIntensity(s.lightIntensity);
      setFogDensity(s.fogDensity);
      setVoxelStyle(s.style);
    }
  }, [historyIndex, history, selectedTile]);

  const handleUndo = useCallback(() => historyIndex > 0 && setHistoryIndex(p => p - 1), [historyIndex]);
  const handleRedo = useCallback(() => historyIndex < history.length - 1 && setHistoryIndex(p => p + 1), [historyIndex, history.length]);

  const pushToHistory = useCallback((newState: UserContent) => {
    setHistory(prev => {
      const updated = prev.slice(0, historyIndex + 1);
      updated.push(newState);
      return updated.length > 15 ? updated.slice(1) : updated;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 14));
  }, [historyIndex]);

  const patchScene = useCallback((paramsOverride?: Partial<{
    backgroundColor: string, 
    autoRotate: boolean,
    lightIntensity: number,
    fogDensity: number
  }>) => {
    if (!voxelCode) return;
    const p = {
      backgroundColor: paramsOverride?.backgroundColor ?? sceneBgColor,
      autoRotate: paramsOverride?.autoRotate ?? autoRotate,
      lightIntensity: paramsOverride?.lightIntensity ?? lightIntensity,
      fogDensity: paramsOverride?.fogDensity ?? fogDensity
    };
    const updated = updateSceneParameters(voxelCode, p);
    setVoxelCode(updated);
    if (selectedTile === 'user' && imageData) {
      pushToHistory({
        image: imageData, voxel: updated, prompt, palette: [...palette],
        backgroundColor: p.backgroundColor, autoRotate: p.autoRotate,
        lightIntensity: p.lightIntensity, fogDensity: p.fogDensity, style: voxelStyle
      });
    }
  }, [voxelCode, sceneBgColor, autoRotate, lightIntensity, fogDensity, selectedTile, imageData, prompt, palette, voxelStyle, pushToHistory]);

  const handleImageGenerate = async () => {
    if (!prompt.trim()) return;
    setStatus('generating_image');
    setErrorMsg('');
    setImageData(null);
    setVoxelCode(null);
    setThinkingText(null);
    setViewMode('image');

    try {
      const imageUrl = await generateImage(prompt, aspectRatio, true);
      const state: UserContent = {
        image: imageUrl, voxel: null, prompt, palette: [...palette], 
        backgroundColor: sceneBgColor, autoRotate, lightIntensity, fogDensity, style: voxelStyle
      };
      pushToHistory(state);
      setSelectedTile('user');
      setStatus('idle');
      setShowGenerator(false);
    } catch (err: any) {
      setStatus('error');
      setErrorMsg(err.message || "Image generation failed.");
    }
  };

  const handleVoxelize = async () => {
    if (!imageData) return;
    setStatus('generating_voxels');
    setErrorMsg('');
    setThinkingText(null);

    try {
      const codeRaw = await generateVoxelScene(imageData, setThinkingText, palette);
      const processed = updateSceneParameters(
        injectExporterBridge(injectSubtleAnimation(hideBodyText(codeRaw))), 
        { backgroundColor: sceneBgColor, autoRotate, lightIntensity, fogDensity }
      );
      setVoxelCode(processed);
      if (selectedTile === 'user') {
        pushToHistory({
          image: imageData, voxel: processed, prompt, palette: [...palette],
          backgroundColor: sceneBgColor, autoRotate, lightIntensity, fogDensity, style: voxelStyle
        });
      }
      setViewMode('voxel');
      setStatus('idle');
    } catch (err: any) {
      setStatus('error');
      setErrorMsg(err.message || "Voxelization failed.");
    }
  };

  const requestSnapshot = (): Promise<string> => {
    return new Promise((resolve) => {
      if (!iframeRef.current || !iframeRef.current.contentWindow || !voxelCode) {
        resolve(imageData || '');
        return;
      }
      pendingSaveResolve.current = resolve;
      iframeRef.current.contentWindow.postMessage({ type: 'GET_SNAPSHOT' }, '*');
      // Timeout fallback
      setTimeout(() => {
        if (pendingSaveResolve.current === resolve) {
          resolve(imageData || '');
          pendingSaveResolve.current = null;
        }
      }, 1000);
    });
  };

  const handleSaveToGallery = async () => {
    if (!imageData) return;
    setStatus('saving');
    
    // Attempt to get a high-quality 3D render snapshot
    const thumbnail = await requestSnapshot();

    const newScene: SavedScene = {
      id: `scene_${Date.now()}`, 
      timestamp: Date.now(), 
      image: imageData, 
      voxel: voxelCode,
      prompt, palette: [...palette], 
      backgroundColor: sceneBgColor, 
      autoRotate, 
      lightIntensity, 
      fogDensity, 
      style: voxelStyle,
      thumbnail
    };
    
    setSavedScenes(prev => [newScene, ...prev]);
    setStatus('idle');
  };

  const handleDeleteScene = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Permanently remove this creation from your vault?")) {
      setSavedScenes(prev => prev.filter(s => s.id !== id));
      if (selectedTile === id) setSelectedTile(null);
    }
  };

  const handleExport = (format: 'OBJ' | 'VOX') => {
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'EXPORT_SCENE', format }, '*');
    }
  };

  const handleSavedTileClick = (scene: SavedScene) => {
    setSelectedTile(scene.id);
    setImageData(scene.image);
    setVoxelCode(scene.voxel);
    setPrompt(scene.prompt);
    setPalette(scene.palette);
    setSceneBgColor(scene.backgroundColor);
    setAutoRotate(scene.autoRotate);
    setLightIntensity(scene.lightIntensity);
    setFogDensity(scene.fogDensity);
    setVoxelStyle(scene.style);
    setViewMode(scene.voxel ? 'voxel' : 'image');
    setShowGenerator(false);
  };

  const isLoading = status !== 'idle' && status !== 'error' && status !== 'saving';

  return (
    <div className="min-h-screen bg-white text-black font-sans selection:bg-yellow-200 py-12 px-6">
      <style>{`
        .loading-dots::after { content: ''; animation: dots 2s steps(4, end) infinite; }
        @keyframes dots { 0%, 20% { content: ''; } 40% { content: '.'; } 60% { content: '..'; } 80% { content: '...'; } }
        .custom-color-input { -webkit-appearance: none; border: none; width: 100%; height: 100%; cursor: pointer; background: none; }
        .custom-color-input::-webkit-color-swatch { border: none; }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>

      {showRoadmap && (
        <div className="fixed inset-0 z-[100] bg-white p-8 overflow-y-auto animate-in fade-in slide-in-from-bottom-8 duration-300">
          <div className="max-w-4xl mx-auto">
            <div className="flex justify-between items-center border-b-4 border-black pb-8 mb-12">
              <h2 className="text-6xl font-black uppercase tracking-tighter italic">The Lab</h2>
              <button onClick={() => setShowRoadmap(false)} className="px-4 py-2 border-4 border-black hover:bg-black hover:text-white transition-all font-black text-xs">BACK TO FORGE</button>
            </div>
            <div className="grid md:grid-cols-2 gap-12">
              <div className="space-y-8">
                <h3 className="text-3xl font-black bg-yellow-300 inline-block px-4 border-2 border-black">V5.0 "VAULT"</h3>
                <ul className="space-y-4 font-bold uppercase text-sm list-disc pl-5">
                  <li>Render-Buffer Snapshots (Thumbnails)</li>
                  <li>Mesh Exporter 3.0 (OBJ, MagicaVoxel)</li>
                  <li>Real-time Atmosphere Patching</li>
                  <li>Undo/Redo History Queue</li>
                </ul>
              </div>
              <div className="space-y-8">
                <h3 className="text-3xl font-black bg-pink-300 inline-block px-4 border-2 border-black">IN PROGRESS</h3>
                <ul className="space-y-4 font-bold uppercase text-sm list-disc pl-5">
                  <li>Multi-object Point Clouds</li>
                  <li>Custom Voxel Physics</li>
                  <li>Direct Web-to-Game Export</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto space-y-12">
        <header className="border-b-4 border-black pb-8 flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
          <div className="space-y-2">
            <h1 className="text-6xl md:text-8xl font-black uppercase leading-[0.8] tracking-tighter">VOXEL<br/>FORGE</h1>
            <p className="text-xl font-bold text-gray-400 uppercase tracking-widest">Procedural 3D Foundry // v5.0</p>
          </div>
          <button onClick={() => setShowRoadmap(true)} className="px-6 py-2 border-4 border-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 transition-all">Project Roadmap</button>
        </header>

        <section className="space-y-6">
          <div className="flex items-end justify-between border-b-2 border-gray-100 pb-2">
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-gray-300">Artifact Vault</h2>
          </div>
          <div className="flex gap-6 overflow-x-auto pb-6 hide-scrollbar">
            {/* Create Button */}
            <button onClick={() => { setSelectedTile('user'); setShowGenerator(true); }} className={`min-w-[120px] aspect-square border-4 border-black flex flex-col items-center justify-center transition-all shrink-0 shadow-[6px_6px_0px_0px_black] active:translate-y-1 active:shadow-none ${selectedTile === 'user' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'}`}>
              <span className="text-4xl font-black">+</span>
              <span className="text-[10px] font-black uppercase tracking-tighter mt-2">New Forge</span>
            </button>
            
            {/* Examples */}
            {EXAMPLES.map((ex, i) => (
              <button key={i} onClick={() => { setSelectedTile(i); setViewMode('voxel'); setImageData(ex.img); setShowGenerator(false); }} className={`min-w-[120px] aspect-square border-4 border-black relative transition-all shrink-0 ${selectedTile === i ? 'scale-105 shadow-[8px_8px_0px_0px_black] z-10' : 'hover:-translate-y-1 hover:shadow-[4px_4px_0px_0px_black]'}`}>
                <img src={loadedThumbnails[ex.id]} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 bg-black text-white text-[8px] font-black py-1 px-2 uppercase tracking-tighter">System Template</div>
              </button>
            ))}

            {/* User Saved Scenes with Snapshots */}
            {savedScenes.map(s => (
              <div key={s.id} className="relative shrink-0 group">
                <button onClick={() => handleSavedTileClick(s)} className={`min-w-[120px] aspect-square border-4 border-black relative transition-all overflow-hidden ${selectedTile === s.id ? 'scale-105 shadow-[8px_8px_0px_0px_black] z-10' : 'hover:-translate-y-1 hover:shadow-[4px_4px_0px_0px_black]'}`}>
                  <img src={s.thumbnail} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center p-2 text-center">
                    <span className="text-white text-[8px] font-black uppercase leading-tight line-clamp-3">{s.prompt}</span>
                  </div>
                </button>
                <button onClick={(e) => handleDeleteScene(s.id, e)} className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white border-2 border-black rounded-full flex items-center justify-center text-xs font-black z-20 opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110 active:scale-90">×</button>
              </div>
            ))}
          </div>
        </section>

        {showGenerator && (
          <div className="p-8 border-4 border-black bg-gray-50 shadow-[10px_10px_0px_0px_black] space-y-8 animate-in slide-in-from-top-4 duration-300">
            <div className="grid md:grid-cols-2 gap-8">
              <div className="space-y-4">
                <label className="block text-sm font-black uppercase">1. Visual Inspiration</label>
                <div onClick={() => fileInputRef.current?.click()} className="h-48 border-4 border-dashed border-black flex flex-col items-center justify-center cursor-pointer bg-white hover:bg-gray-100 transition-all relative overflow-hidden">
                  <input type="file" ref={fileInputRef} onChange={(e) => { const f = e.target.files?.[0]; if(f) { const r = new FileReader(); r.onload=(ev)=>setImageData(ev.target?.result as string); r.readAsDataURL(f); } }} className="hidden" />
                  {imageData ? <img src={imageData} className="absolute inset-0 w-full h-full object-cover opacity-30" /> : null}
                  <div className="relative z-10 flex flex-col items-center">
                    <span className="text-3xl mb-2">🖼️</span>
                    <span className="font-black uppercase text-xs">Drop Image or Click</span>
                  </div>
                </div>
              </div>
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="block text-sm font-black uppercase">2. Manifest Description</label>
                  <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={SAMPLE_PROMPTS[placeholderIndex]} className="w-full p-4 border-4 border-black focus:outline-none font-bold placeholder:text-gray-300 h-24 resize-none" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="block text-[10px] font-black uppercase text-gray-400">Geometry</label>
                    <select value={aspectRatio} onChange={e => setAspectRatio(e.target.value)} className="w-full p-2 border-2 border-black font-bold uppercase text-xs bg-white">
                      {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="block text-[10px] font-black uppercase text-gray-400">Art Style</label>
                    <select value={voxelStyle} onChange={e => setVoxelStyle(e.target.value as VoxelStyle)} className="w-full p-2 border-2 border-black font-bold uppercase text-xs bg-white">
                      {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-4 border-t-2 border-black pt-6">
              <button onClick={handleImageGenerate} disabled={isLoading || !prompt} className="px-10 py-3 bg-black text-white font-black uppercase shadow-[6px_6px_0px_0px_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none disabled:opacity-50 transition-all">Ignite Forge</button>
            </div>
          </div>
        )}

        {imageData && (
          <div className="grid md:grid-cols-12 gap-8 items-start">
            <div className="md:col-span-8 space-y-6">
              <div className="aspect-square border-4 border-black bg-gray-100 relative overflow-hidden shadow-[12px_12px_0px_0px_black]">
                {isLoading && (
                  <div className="absolute inset-0 z-50 bg-white/95 p-12 flex flex-col justify-center">
                    <h3 className="text-4xl font-black uppercase italic mb-4 animate-pulse">Forging World<span className="loading-dots"></span></h3>
                    <div className="font-mono text-xs text-gray-400 border-l-4 border-black pl-4 py-2 bg-gray-50 uppercase tracking-tighter max-h-48 overflow-y-auto">
                      {thinkingText || "Transmuting image to voxel coordinates..."}
                    </div>
                  </div>
                )}
                {status === 'saving' && (
                  <div className="absolute inset-0 z-50 bg-black/60 flex flex-col items-center justify-center backdrop-blur-sm">
                    <div className="w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin mb-4"></div>
                    <span className="text-white font-black uppercase text-xs tracking-widest">Capturing Scene...</span>
                  </div>
                )}
                {viewMode === 'image' && <img src={imageData} className="w-full h-full object-contain" />}
                {viewMode === 'voxel' && voxelCode && (
                  <iframe 
                    ref={iframeRef}
                    srcDoc={voxelCode} 
                    className="w-full h-full border-none" 
                    sandbox="allow-scripts allow-same-origin" 
                    crossOrigin="anonymous"
                  />
                )}
              </div>
              
              <div className="flex gap-4">
                <button onClick={() => setViewMode(viewMode === 'image' ? 'voxel' : 'image')} disabled={!voxelCode} className={`flex-1 py-4 border-4 border-black font-black uppercase shadow-[6px_6px_0px_0px_black] transition-all active:translate-y-1 active:shadow-none ${viewMode === 'image' ? 'bg-white hover:bg-black hover:text-white' : 'bg-black text-white hover:bg-yellow-300 hover:text-black'}`}>
                  {viewMode === 'image' ? 'View 3D Forge' : 'View Source Ref'}
                </button>
                <button onClick={handleVoxelize} disabled={isLoading} className="flex-1 py-4 bg-yellow-300 text-black border-4 border-black font-black uppercase shadow-[6px_6px_0px_0px_rgba(0,0,0,0.8)] hover:bg-black hover:text-white transition-all active:translate-y-1 active:shadow-none disabled:opacity-50">
                  Transmute to Voxel
                </button>
              </div>
            </div>

            <div className="md:col-span-4 space-y-8 animate-in slide-in-from-right-4 duration-500">
              <div className="border-4 border-black bg-white shadow-[6px_6px_0px_0px_black] overflow-hidden">
                <div className="flex bg-gray-100 border-b-4 border-black">
                  {(['transform', 'atmosphere', 'export'] as InspectorTab[]).map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-3 text-[9px] font-black uppercase tracking-widest border-r-2 last:border-r-0 border-black transition-colors ${activeTab === tab ? 'bg-black text-white' : 'bg-white text-black hover:bg-yellow-50'}`}>
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="p-6 space-y-6">
                  {activeTab === 'transform' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="block text-[10px] font-black uppercase text-gray-400">Camera Viewpoints</label>
                        <div className="grid grid-cols-2 gap-2">
                          {['isometric', 'top', 'front', 'side'].map(angle => (
                            <button key={angle} onClick={() => {
                              if (voxelCode) {
                                const views = {
                                  isometric: { x: 40, y: 40, z: 40 },
                                  top: { x: 0.1, y: 60, z: 0 },
                                  front: { x: 0, y: 10, z: 60 },
                                  side: { x: 60, y: 10, z: 0 }
                                };
                                const updated = setCameraView(voxelCode, views[angle as keyof typeof views]);
                                setVoxelCode(updated);
                              }
                            }} className="py-2 border-2 border-black font-black text-[8px] uppercase hover:bg-black hover:text-white transition-all bg-gray-50">
                              {angle}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="block text-[10px] font-black uppercase text-gray-400">Animation</label>
                        <button onClick={() => { setAutoRotate(!autoRotate); patchScene({ autoRotate: !autoRotate }); }} className={`w-full py-2 border-2 border-black font-black text-[10px] uppercase transition-all ${autoRotate ? 'bg-black text-white' : 'bg-white hover:bg-gray-100'}`}>
                          Orbit Mode: {autoRotate ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    </div>
                  )}

                  {activeTab === 'atmosphere' && (
                    <div className="space-y-6">
                      <div className="space-y-2">
                        <label className="block text-[10px] font-black uppercase text-gray-400">Sun Power</label>
                        <input type="range" min="0.1" max="3" step="0.1" value={lightIntensity} onChange={e => { setLightIntensity(Number(e.target.value)); patchScene({ lightIntensity: Number(e.target.value) }); }} className="w-full accent-black cursor-pointer" />
                      </div>
                      <div className="space-y-2">
                        <label className="block text-[10px] font-black uppercase text-gray-400">Fog Thickness</label>
                        <input type="range" min="0" max="2" step="0.1" value={fogDensity} onChange={e => { setFogDensity(Number(e.target.value)); patchScene({ fogDensity: Number(e.target.value) }); }} className="w-full accent-black cursor-pointer" />
                      </div>
                      <div className="space-y-2">
                        <label className="block text-[10px] font-black uppercase text-gray-400">Horizon Tint</label>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 border-2 border-black shadow-[3px_3px_0px_0px_black] overflow-hidden">
                            <input type="color" value={sceneBgColor} onChange={e => { setSceneBgColor(e.target.value); patchScene({ backgroundColor: e.target.value }); }} className="custom-color-input" />
                          </div>
                          <span className="text-[10px] font-mono font-bold uppercase border-b border-black pb-1">{sceneBgColor}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeTab === 'export' && (
                    <div className="space-y-4">
                      <div className="p-3 bg-blue-50 border-2 border-black text-[9px] font-bold leading-tight uppercase italic">
                        Ready for Export: Extract mesh data for Blender or MagicaVoxel.
                      </div>
                      <div className="space-y-3">
                        <button 
                          onClick={() => handleExport('OBJ')}
                          disabled={!voxelCode}
                          className="w-full py-3 bg-white border-2 border-black font-black text-xs uppercase shadow-[4px_4px_0px_0px_black] hover:bg-black hover:text-white active:translate-y-1 active:shadow-none transition-all disabled:opacity-30"
                        >
                          Download .OBJ
                        </button>
                        <button 
                          onClick={() => handleExport('VOX')}
                          disabled={!voxelCode}
                          className="w-full py-3 bg-white border-2 border-black font-black text-xs uppercase shadow-[4px_4px_0px_0px_black] hover:bg-black hover:text-white active:translate-y-1 active:shadow-none transition-all disabled:opacity-30"
                        >
                          Download .VOX
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-4 border-t-2 border-black flex gap-2 bg-gray-50">
                  <button onClick={handleUndo} disabled={historyIndex <= 0} className="flex-1 py-1 border-2 border-black text-[8px] font-black uppercase disabled:opacity-30 bg-white hover:bg-black hover:text-white transition-all">Undo</button>
                  <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="flex-1 py-1 border-2 border-black text-[8px] font-black uppercase disabled:opacity-30 bg-white hover:bg-black hover:text-white transition-all">Redo</button>
                  <button onClick={handleSaveToGallery} disabled={status === 'saving'} className="flex-1 py-1 bg-yellow-300 border-2 border-black font-black uppercase text-[8px] shadow-[3px_3px_0px_0px_black] active:shadow-none hover:bg-black hover:text-white transition-all">
                    {status === 'saving' ? 'Capturing...' : 'Secure V'}
                  </button>
                </div>
              </div>
              
              {errorMsg && <div className="p-4 border-4 border-red-500 bg-red-50 text-red-700 text-xs font-black uppercase tracking-tighter">Forge Error: {errorMsg}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
