import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  X,
  Check,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RotateCw,
  ArrowUp,
  ArrowDown,
  Crosshair,
} from "lucide-react";
import { triggerHaptic } from "../lib/haptics";
import { isPerformanceModeEnabled } from "../lib/utils";

interface ImageCropperModalProps {
  isOpen: boolean;
  imageSrc: string | null;
  shape?: "circle" | "square";
  title?: string;
  targetSize?: number;
  onClose: () => void;
  onConfirm: (croppedDataUrl: string) => void;
}

const VIEWPORT_SIZE = 232;
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 3.0;

export function ImageCropperModal({
  isOpen,
  imageSrc,
  shape = "circle",
  title = "Adjust Photo",
  targetSize = 320,
  onClose,
  onConfirm,
}: ImageCropperModalProps) {
  const perfMode = isPerformanceModeEnabled();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ width: 320, height: 320 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [activePreset, setActivePreset] = useState<"top" | "center" | "bottom" | "custom">("center");
  const [isSaving, setIsSaving] = useState(false);

  const dragStartRef = useRef({
    pointerX: 0,
    pointerY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
  });

  // Base dimensions that strictly cover the VIEWPORT_SIZE square at zoom = 1
  const getBaseRenderedSize = useCallback(
    (natW: number, natH: number, rot = rotation) => {
      const isQuarterTurn = rot % 180 !== 0;
      const effectiveW = Math.max(1, isQuarterTurn ? natH : natW);
      const effectiveH = Math.max(1, isQuarterTurn ? natW : natH);
      const scale = Math.max(VIEWPORT_SIZE / effectiveW, VIEWPORT_SIZE / effectiveH);
      return {
        width: Math.max(1, natW) * scale,
        height: Math.max(1, natH) * scale,
        effectiveWidth: effectiveW * scale,
        effectiveHeight: effectiveH * scale,
        scale,
      };
    },
    [rotation]
  );

  // Strictly clamp pan offsets so the image NEVER goes out of bounds of the crop frame
  const clampOffset = useCallback(
    (
      nextX: number,
      nextY: number,
      targetZoom: number,
      natW = naturalSize.width,
      natH = naturalSize.height,
      rot = rotation
    ) => {
      const base = getBaseRenderedSize(natW, natH, rot);
      const scaledW = base.effectiveWidth * targetZoom;
      const scaledH = base.effectiveHeight * targetZoom;
      const maxX = Math.max(0, (scaledW - VIEWPORT_SIZE) / 2);
      const maxY = Math.max(0, (scaledH - VIEWPORT_SIZE) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, nextX)),
        y: Math.max(-maxY, Math.min(maxY, nextY)),
        maxX,
        maxY,
      };
    },
    [getBaseRenderedSize, naturalSize.height, naturalSize.width, rotation]
  );

  // Reset state when modal opens with a newly uploaded image
  useEffect(() => {
    if (!isOpen || !imageSrc) {
      setImgLoaded(false);
      return;
    }
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
    setActivePreset("center");
    setIsSaving(false);
  }, [isOpen, imageSrc]);

  // Close on Escape or Android hardware back button
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleBack = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("androidBackPress", handleBack);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("androidBackPress", handleBack);
    };
  }, [isOpen, onClose]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const w = img.naturalWidth || img.width || 320;
    const h = img.naturalHeight || img.height || 320;
    imgRef.current = img;
    setNaturalSize({ width: w, height: h });
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
    setActivePreset("center");
    setImgLoaded(true);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!imgLoaded) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {}
    setIsDragging(true);
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startOffsetX: offset.x,
      startOffsetY: offset.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !imgLoaded) return;
    e.preventDefault();
    const dx = e.clientX - dragStartRef.current.pointerX;
    const dy = e.clientY - dragStartRef.current.pointerY;
    const clamped = clampOffset(
      dragStartRef.current.startOffsetX + dx,
      dragStartRef.current.startOffsetY + dy,
      zoom
    );
    setOffset({ x: clamped.x, y: clamped.y });
    setActivePreset("custom");
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {}
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    handleZoomChange(zoom + delta);
  };

  const handleZoomChange = (newZoomRaw: number) => {
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(newZoomRaw.toFixed(2))));
    const clamped = clampOffset(offset.x, offset.y, nextZoom);
    setZoom(nextZoom);
    setOffset({ x: clamped.x, y: clamped.y });
  };

  const applyVerticalPreset = (preset: "top" | "center" | "bottom") => {
    triggerHaptic("selection");
    setIsDragging(false);

    if (preset === "center") {
      const clamped = clampOffset(0, 0, zoom);
      setOffset({ x: clamped.x, y: clamped.y });
      setActivePreset("center");
      return;
    }

    // Check if current zoom has enough vertical overflow to pan without going out of bounds.
    // If the image is square or wide and has < 28px of vertical overflow, automatically zoom in
    // slightly (1.28x) so Top/Bottom shifts the framing cleanly while staying 100% inside the frame!
    let targetZoom = zoom;
    let bounds = clampOffset(0, 0, targetZoom);
    if (bounds.maxY < 28) {
      targetZoom = Math.max(zoom, 1.28);
      setZoom(targetZoom);
      bounds = clampOffset(0, 0, targetZoom);
    }

    if (preset === "top") {
      setOffset({ x: 0, y: bounds.maxY });
      setActivePreset("top");
    } else {
      setOffset({ x: 0, y: -bounds.maxY });
      setActivePreset("bottom");
    }
  };

  const handleRotate = () => {
    triggerHaptic("light");
    setIsDragging(false);
    const nextRot = (rotation + 90) % 360;
    const clamped = clampOffset(offset.x, offset.y, zoom, naturalSize.width, naturalSize.height, nextRot);
    setRotation(nextRot);
    setOffset({ x: clamped.x, y: clamped.y });
  };

  const handleReset = () => {
    triggerHaptic("light");
    setIsDragging(false);
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
    setActivePreset("center");
  };

  const handleSaveCrop = () => {
    if (!imgRef.current || isSaving) return;
    setIsSaving(true);
    triggerHaptic("medium");

    try {
      const img = imgRef.current;
      const natW = naturalSize.width;
      const natH = naturalSize.height;
      const base = getBaseRenderedSize(natW, natH, rotation);
      const clamped = clampOffset(offset.x, offset.y, zoom, natW, natH, rotation);

      const canvas = document.createElement("canvas");
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext("2d");

      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const exportRatio = targetSize / VIEWPORT_SIZE;

        ctx.save();
        ctx.translate(
          targetSize / 2 + clamped.x * exportRatio,
          targetSize / 2 + clamped.y * exportRatio
        );
        if (rotation !== 0) {
          ctx.rotate((rotation * Math.PI) / 180);
        }
        ctx.scale(zoom, zoom);
        const drawW = base.width * exportRatio;
        const drawH = base.height * exportRatio;
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
      }

      let outputUrl = "";
      try {
        const webp = canvas.toDataURL("image/webp", 0.86);
        if (webp.startsWith("data:image/webp")) {
          outputUrl = webp;
        }
      } catch {}

      if (!outputUrl) {
        outputUrl = canvas.toDataURL("image/jpeg", 0.86);
      }

      triggerHaptic("success");
      onConfirm(outputUrl);
    } catch (err) {
      console.error("Failed to crop image:", err);
      if (imageSrc) onConfirm(imageSrc);
    } finally {
      setIsSaving(false);
    }
  };

  if (typeof document === "undefined") return null;

  const baseDims = getBaseRenderedSize(naturalSize.width, naturalSize.height, rotation);
  const zoomPercent = Math.round(zoom * 100);

  return createPortal(
    <AnimatePresence>
      {isOpen && imageSrc && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-3 sm:p-4">
          <motion.div
            initial={perfMode ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={perfMode ? undefined : { opacity: 0 }}
            transition={perfMode ? { duration: 0 } : { duration: 0.18 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-950/80 backdrop-blur-md"
          />

          <motion.div
            initial={perfMode ? false : { opacity: 0, scale: 0.94, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={perfMode ? undefined : { opacity: 0, scale: 0.95, y: 10 }}
            transition={
              perfMode
                ? { duration: 0 }
                : { type: "spring", stiffness: 420, damping: 30, mass: 0.75 }
            }
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 w-full max-w-[356px] max-h-[94dvh] rounded-[2rem] bg-white dark:bg-[#141722] border border-slate-200/90 dark:border-white/[0.09] shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between border-b border-slate-200/70 dark:border-white/[0.06] shrink-0">
              <div className="min-w-0">
                <h3 className="text-[15px] font-extrabold text-slate-900 dark:text-white tracking-tight">
                  {title}
                </h3>
                <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Drag to position or zoom before saving
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic("light");
                  onClose();
                }}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-white/[0.07] hover:bg-slate-200 dark:hover:bg-white/[0.14] flex items-center justify-center text-slate-600 dark:text-slate-300 transition-colors cursor-pointer shrink-0"
              >
                <X size={16} />
              </button>
            </div>

            {/* Studio Stage */}
            <div className="px-4 pt-3 pb-3 flex flex-col items-center overflow-y-auto">
              <div className="relative p-2.5 rounded-[1.75rem] bg-slate-950/95 border border-slate-800/80 shadow-inner flex flex-col items-center">
                {/* Interactive Crop Viewport — Strictly Clamped In-Bounds */}
                <div
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onWheel={handleWheel}
                  style={{ width: VIEWPORT_SIZE, height: VIEWPORT_SIZE }}
                  className={`relative overflow-hidden bg-slate-900 select-none touch-none ${
                    shape === "circle" ? "rounded-full" : "rounded-[1.5rem]"
                  } ${
                    isDragging ? "cursor-grabbing" : "cursor-grab"
                  } ring-2 ring-indigo-500/50 shadow-2xl`}
                >
                  <img
                    src={imageSrc}
                    alt="Crop preview"
                    draggable={false}
                    onLoad={handleImageLoad}
                    style={{
                      width: `${baseDims.width}px`,
                      height: `${baseDims.height}px`,
                      left: `${(VIEWPORT_SIZE - baseDims.width) / 2}px`,
                      top: `${(VIEWPORT_SIZE - baseDims.height) / 2}px`,
                      transform: `translate3d(${offset.x}px, ${offset.y}px, 0) rotate(${rotation}deg) scale(${zoom})`,
                      transformOrigin: "center center",
                      transition: isDragging
                        ? "none"
                        : "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)",
                    }}
                    className="absolute max-w-none pointer-events-none select-none will-change-transform"
                  />

                  {/* Subtle Rule-of-Thirds Grid Overlay while dragging */}
                  <div
                    className={`pointer-events-none absolute inset-0 transition-opacity duration-150 ${
                      isDragging ? "opacity-90" : "opacity-0"
                    }`}
                  >
                    <div className="w-full h-full grid grid-cols-3 grid-rows-3">
                      {Array.from({ length: 9 }).map((_, idx) => (
                        <div key={idx} className="border border-white/25" />
                      ))}
                    </div>
                  </div>

                  {/* Crisp Frame Ring */}
                  <div
                    className={`pointer-events-none absolute inset-0 border-2 border-white/60 ${
                      shape === "circle" ? "rounded-full" : "rounded-[1.5rem]"
                    }`}
                  />
                </div>

                {/* Status Bar */}
                <div className="mt-2 flex items-center justify-between w-full px-1 text-[10.5px] font-semibold text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                    <span>Drag inside frame to adjust</span>
                  </span>
                  <span className="font-mono text-indigo-300 font-bold">
                    {zoomPercent}%
                  </span>
                </div>
              </div>

              {/* Alignment & Utility Controls */}
              <div className="w-full mt-2.5 flex items-center gap-1.5">
                <div className="grid grid-cols-3 gap-1 bg-slate-100 dark:bg-[#1e2231] p-1 rounded-xl flex-1 border border-slate-200/70 dark:border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => applyVerticalPreset("top")}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                      activePreset === "top"
                        ? "bg-indigo-600 text-white shadow-xs"
                        : "text-slate-600 dark:text-slate-300 hover:bg-white/60 dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    <ArrowUp size={12} />
                    <span>Top</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => applyVerticalPreset("center")}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                      activePreset === "center"
                        ? "bg-indigo-600 text-white shadow-xs"
                        : "text-slate-600 dark:text-slate-300 hover:bg-white/60 dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    <Crosshair size={12} />
                    <span>Center</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => applyVerticalPreset("bottom")}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                      activePreset === "bottom"
                        ? "bg-indigo-600 text-white shadow-xs"
                        : "text-slate-600 dark:text-slate-300 hover:bg-white/60 dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    <ArrowDown size={12} />
                    <span>Bottom</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleRotate}
                  title="Rotate 90°"
                  className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-[#1e2231] border border-slate-200/70 dark:border-white/[0.06] text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-300 active:scale-95 flex items-center justify-center transition-all cursor-pointer shrink-0"
                >
                  <RotateCw size={14} />
                </button>

                <button
                  type="button"
                  onClick={handleReset}
                  title="Reset framing"
                  className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-[#1e2231] border border-slate-200/70 dark:border-white/[0.06] text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-300 active:scale-95 flex items-center justify-center transition-all cursor-pointer shrink-0"
                >
                  <RotateCcw size={14} />
                </button>
              </div>

              {/* Smooth Zoom Control Bar (1.0x to 3.0x — Never goes out of bounds) */}
              <div className="w-full mt-2 flex items-center gap-2 bg-slate-100 dark:bg-[#1e2231] border border-slate-200/70 dark:border-white/[0.06] px-2.5 py-1.5 rounded-xl">
                <button
                  type="button"
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() => {
                    triggerHaptic("light");
                    handleZoomChange(zoom - 0.15);
                  }}
                  className="w-7 h-7 rounded-lg bg-white dark:bg-white/[0.07] hover:bg-indigo-50 dark:hover:bg-white/[0.14] text-slate-700 dark:text-slate-200 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none shrink-0"
                >
                  <ZoomOut size={14} />
                </button>
                <input
                  type="range"
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={0.02}
                  value={zoom}
                  onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
                  className="flex-1 accent-indigo-600 dark:accent-indigo-400 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-lg cursor-pointer"
                />
                <button
                  type="button"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => {
                    triggerHaptic("light");
                    handleZoomChange(zoom + 0.15);
                  }}
                  className="w-7 h-7 rounded-lg bg-white dark:bg-white/[0.07] hover:bg-indigo-50 dark:hover:bg-white/[0.14] text-slate-700 dark:text-slate-200 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none shrink-0"
                >
                  <ZoomIn size={14} />
                </button>
              </div>
            </div>

            {/* Footer Actions */}
            <div className="px-4 pb-3.5 pt-1 flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic("light");
                  onClose();
                }}
                className="flex-1 h-10 rounded-xl font-bold text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-white/[0.06] hover:bg-slate-200 dark:hover:bg-white/[0.11] border border-slate-200/70 dark:border-white/[0.06] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!imgLoaded || isSaving}
                onClick={handleSaveCrop}
                className="flex-[1.45] h-10 rounded-xl font-bold text-xs text-white bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 active:scale-[0.98] shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
              >
                <Check size={15} strokeWidth={2.5} />
                <span>{isSaving ? "Saving..." : "Save Photo"}</span>
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
