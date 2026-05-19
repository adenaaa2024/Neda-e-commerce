import type { MediaUploadFolder, StorageBucketName } from "../media-upload-types";
import { uploadMediaFileAction } from "../media-upload-actions";
import { resolveOrganizationId } from "../organization";
import { isAlignedStorageRelativePath } from "../storage-helpers";

export type UploadFolder = MediaUploadFolder;

function bucketForFolder(folder: MediaUploadFolder): StorageBucketName {
  if (folder === "packages/manifest" || folder === "pallets/manifest") return "manifests";
  return "media";
}

/**
 * Uploads a File via a Server Action (service role) and returns the public URL.
 * Passes `organization_id` so Storage paths and RLS policies can scope by tenant.
 * Packing slips / manifest scans use the `manifests` bucket; all other paths use `media`.
 */
export async function uploadToStorage(
  file: File,
  folder: UploadFolder = "packages",
  organizationId?: string,
): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("folder", folder);
  fd.append("bucket", bucketForFolder(folder));
  fd.append("organization_id", organizationId ?? resolveOrganizationId());
  const res = await uploadMediaFileAction(fd);
  if (!res.ok) throw new Error(res.error);
  return res.publicUrl;
}

/** Upload evidence images to the `media` bucket (public URLs). */
export async function uploadToMedia(
  file: File,
  folder: UploadFolder = "incident",
  organizationId?: string,
): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("folder", folder);
  fd.append("bucket", "media");
  fd.append("organization_id", organizationId ?? resolveOrganizationId());
  const res = await uploadMediaFileAction(fd);
  if (!res.ok) throw new Error(res.error);
  return res.publicUrl;
}

/** Aligned operator paths: `{org_id}/{relativePathUnderOrg}/{unique}.ext` (see `lib/storage-helpers.ts`). */
export async function uploadToMediaAligned(
  file: File,
  organizationId: string,
  opts: { bucket: "media" | "manifests"; relativePathUnderOrg: string },
): Promise<string> {
  const rel = opts.relativePathUnderOrg.trim().replace(/^\/+|\/+$/g, "");
  if (!isAlignedStorageRelativePath(rel)) {
    throw new Error("Invalid aligned storage path.");
  }
  const fd = new FormData();
  fd.append("file", file);
  fd.append("relative_path_under_org", rel);
  fd.append("bucket", opts.bucket);
  fd.append("organization_id", organizationId.trim());
  const res = await uploadMediaFileAction(fd);
  if (!res.ok) throw new Error(res.error);
  return res.publicUrl;
}

/** @deprecated Use {@link uploadToMedia} */
export const uploadToIncidentPhotos = uploadToMedia;
