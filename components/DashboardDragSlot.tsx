"use client";

import React, { useCallback, useState } from "react";
import { GripVertical } from "lucide-react";

type DashboardDragSlotProps = {
  id: string;
  className?: string;
  onSwap: (sourceId: string, targetId: string) => void;
  children: React.ReactNode;
};

/** Drag handle — drop on another widget to swap order. */
export function DashboardDragSlot({ id, className, onSwap, children }: DashboardDragSlotProps) {
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
        window.setTimeout(() => setJustSwapped(false), 480);
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
      <button
        type="button"
        draggable
        aria-label="Drag to reorder"
        title="Drag onto another widget to swap"
        className="cc-drag-handle absolute right-1.5 top-1.5 z-10 flex h-6 w-6 cursor-grab items-center justify-center rounded-md border border-border/80 bg-card/90 text-muted-foreground opacity-0 transition-opacity group-hover/drag:opacity-100 active:cursor-grabbing"
        onDragStart={onHandleDragStart}
        onDragEnd={onDragEnd}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      {children}
    </div>
  );
}
