"use client";

import React, { useCallback, useState } from "react";
import { GripVertical, Maximize2, Minimize2 } from "lucide-react";

type DashboardDragSlotProps = {
  id: string;
  className?: string;
  onSwap: (sourceId: string, targetId: string) => void;
  /** Toggle widget footprint (compact ↔ wide). */
  onCycleSize?: () => void;
  sizeMode?: "compact" | "wide";
  children: React.ReactNode;
};

/** Puzzle-style drag — drop on another widget to swap places; optional size toggle. */
export function DashboardDragSlot({
  id,
  className,
  onSwap,
  onCycleSize,
  sizeMode = "compact",
  children,
}: DashboardDragSlotProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const [justSwapped, setJustSwapped] = useState(false);

  const onHandleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData("application/x-dashboard-widget", id);
      e.dataTransfer.effectAllowed = "move";
      setIsDragging(true);
    },
    [id],
  );

  const onDragEnd = useCallback(() => {
    setIsDragging(false);
    setIsOver(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsOver(false);
      setIsDragging(false);
      const sourceId = e.dataTransfer.getData("application/x-dashboard-widget");
      if (sourceId && sourceId !== id) {
        onSwap(sourceId, id);
        setJustSwapped(true);
        window.setTimeout(() => setJustSwapped(false), 540);
      }
    },
    [id, onSwap],
  );

  return (
    <div
      className={[
        "cc-drag-slot group/drag relative",
        isDragging ? "cc-drag-slot--dragging" : "",
        isOver ? "cc-drag-slot--over" : "",
        justSwapped ? "cc-drag-slot--swapped" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="cc-drag-slot__controls absolute right-1.5 top-1.5 z-20 flex items-center gap-1">
        {onCycleSize ? (
          <button
            type="button"
            aria-label={sizeMode === "wide" ? "Make widget compact" : "Make widget wider"}
            title={sizeMode === "wide" ? "Compact size" : "Wide size"}
            className="cc-drag-size-btn flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onCycleSize();
            }}
          >
            {sizeMode === "wide" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        <button
          type="button"
          draggable
          aria-label="Drag to reorder"
          title="Drag onto another widget to swap"
          className="cc-drag-handle flex h-7 w-7 cursor-grab items-center justify-center rounded-md border border-border bg-card text-muted-foreground active:cursor-grabbing"
          onDragStart={onHandleDragStart}
          onDragEnd={onDragEnd}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </div>
      {children}
    </div>
  );
}
