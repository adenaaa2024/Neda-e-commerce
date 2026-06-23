/**
 * Returns & Logistics — printable PDF report document (Phase 1, client-only).
 *
 * Renders a clean, single-tab summary report: brand header, report scope,
 * summary stats, and the current table view (visible columns + filtered rows,
 * already trimmed for readability by the caller). Frontend-only: it receives a
 * fully materialized export matrix and metadata, so it can never widen company
 * scope or include hidden columns / unfiltered rows.
 */

import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { ReturnsExportMatrix, ReturnsExportTab } from "../../lib/returns-report-export";
import {
  RETURNS_PDF_BRAND,
  RETURNS_PDF_REPORT_TITLE,
  type ReturnsPdfHeaderMeta,
  type ReturnsPdfSummaryStat,
} from "../../lib/returns-report-pdf";

const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 32,
    paddingHorizontal: 28,
    fontSize: 8,
    fontFamily: "Helvetica",
    color: "#171A1E",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1.5,
    borderBottomColor: "#8A681F",
    paddingBottom: 8,
    marginBottom: 8,
  },
  brand: { fontSize: 18, fontWeight: "bold", color: "#8A681F", letterSpacing: 1 },
  brandSub: { fontSize: 7, color: "#737C86", marginTop: 2 },
  title: { fontSize: 12, fontWeight: "bold", color: "#171A1E", textAlign: "right" as const },
  generated: { fontSize: 7, color: "#737C86", marginTop: 3, textAlign: "right" as const },
  metaWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: "#F3EFE6",
    borderWidth: 1,
    borderColor: "#E4D9BF",
    borderRadius: 4,
    paddingVertical: 5,
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  metaCell: { width: "33.33%", paddingVertical: 2, paddingRight: 6 },
  metaLabel: {
    fontSize: 6.5,
    fontWeight: "bold",
    color: "#737C86",
    textTransform: "uppercase" as const,
    letterSpacing: 0.3,
  },
  metaValue: { fontSize: 8, color: "#171A1E", marginTop: 1 },
  summaryRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 10, gap: 6 },
  summaryChip: {
    borderWidth: 1,
    borderColor: "#D9CBB1",
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: "#FFFFFF",
  },
  summaryChipLabel: {
    fontSize: 6.5,
    color: "#737C86",
    textTransform: "uppercase" as const,
    letterSpacing: 0.3,
  },
  summaryChipValue: { fontSize: 11, fontWeight: "bold", color: "#8A681F", marginTop: 1 },
  tableNote: { fontSize: 7, color: "#8A5A1F", fontStyle: "italic", marginBottom: 6 },
  table: { borderWidth: 1, borderColor: "#D9CBB1", borderRadius: 3, overflow: "hidden" },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#EFE6D2",
    borderBottomWidth: 1,
    borderBottomColor: "#C9B68A",
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#E8E0CF",
  },
  tableRowAlt: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#E8E0CF",
    backgroundColor: "#FBF8F1",
  },
  th: {
    fontSize: 6.5,
    fontWeight: "bold",
    color: "#6C5320",
    paddingVertical: 4,
    paddingHorizontal: 4,
    textTransform: "uppercase" as const,
  },
  td: {
    fontSize: 6.5,
    color: "#171A1E",
    paddingVertical: 3.5,
    paddingHorizontal: 4,
  },
  emptyNote: { fontSize: 8, color: "#737C86", fontStyle: "italic", padding: 8 },
  footer: {
    position: "absolute",
    bottom: 16,
    left: 28,
    right: 28,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 6.5,
    color: "#94a3b8",
    borderTopWidth: 0.5,
    borderTopColor: "#E8E0CF",
    paddingTop: 4,
  },
});

function formatGeneratedAt(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toLocaleString();
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ReturnsReportPdfDocument({
  tab,
  meta,
  summary,
  matrix,
  totalRows,
  truncationNote,
}: {
  tab: ReturnsExportTab;
  meta: ReturnsPdfHeaderMeta;
  summary: ReturnsPdfSummaryStat[];
  /** Already limited (visible columns, filtered rows) for PDF readability. */
  matrix: ReturnsExportMatrix;
  /** Total filtered rows before any PDF truncation. */
  totalRows: number;
  /** Note to show when rows were trimmed (null when all rows fit). */
  truncationNote: string | null;
}) {
  const title = RETURNS_PDF_REPORT_TITLE[tab];
  const colCount = Math.max(1, matrix.headers.length);
  const colWidth = `${100 / colCount}%`;
  const generatedLabel = formatGeneratedAt(meta.generatedAt);

  return (
    <Document title={title} author={RETURNS_PDF_BRAND}>
      <Page size="A4" orientation="landscape" style={styles.page} wrap>
        <View style={styles.headerRow} fixed>
          <View>
            <Text style={styles.brand}>{RETURNS_PDF_BRAND}</Text>
            <Text style={styles.brandSub}>Returns &amp; Logistics · Smart Omnichannel ERP</Text>
          </View>
          <View>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.generated}>Generated {generatedLabel}</Text>
          </View>
        </View>

        <View style={styles.metaWrap}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Company scope</Text>
            <Text style={styles.metaValue}>{meta.companyScope || "—"}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Store filter</Text>
            <Text style={styles.metaValue}>{meta.storeScope || "—"}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Saved view</Text>
            <Text style={styles.metaValue}>{meta.activeViewName?.trim() || "—"}</Text>
          </View>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryChip}>
            <Text style={styles.summaryChipLabel}>Total rows</Text>
            <Text style={styles.summaryChipValue}>{totalRows}</Text>
          </View>
          {summary.map((s) => (
            <View key={s.label} style={styles.summaryChip}>
              <Text style={styles.summaryChipLabel}>{s.label}</Text>
              <Text style={styles.summaryChipValue}>{s.value}</Text>
            </View>
          ))}
        </View>

        {truncationNote ? <Text style={styles.tableNote}>{truncationNote}</Text> : null}

        {matrix.rows.length === 0 ? (
          <View style={styles.table}>
            <Text style={styles.emptyNote}>No rows match the current filters.</Text>
          </View>
        ) : (
          <View style={styles.table}>
            <View style={styles.tableHeaderRow} fixed>
              {matrix.headers.map((h, i) => (
                <Text key={i} style={[styles.th, { width: colWidth }]}>
                  {h}
                </Text>
              ))}
            </View>
            {matrix.rows.map((row, ri) => (
              <View key={ri} style={ri % 2 === 0 ? styles.tableRow : styles.tableRowAlt} wrap={false}>
                {matrix.headers.map((_, ci) => (
                  <Text key={ci} style={[styles.td, { width: colWidth }]}>
                    {row[ci] ?? ""}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>
            {RETURNS_PDF_BRAND} · {title}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
