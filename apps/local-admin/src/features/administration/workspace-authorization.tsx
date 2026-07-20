import {
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  HardDrive,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  browseDirectories,
  type DirectoryBrowseResult,
  inspectDirectories,
  LocalAdminApiError,
  type WorkspaceInspection,
} from "@/api/local-admin";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { inputClassName } from "@/features/administration/administration-ui";
import { useI18n } from "@/lib/i18n/i18n-context";
import type { TranslationMessages } from "@/lib/i18n/message-schema";
import { cn } from "@/lib/utils";

export function WorkspaceAuthorization({
  busy,
  confirmedHighRiskRoots,
  csrfToken,
  onConfirmedHighRiskRootsChange,
  onWorkspaceRootsChange,
  workspaceRoots,
}: {
  busy: boolean;
  confirmedHighRiskRoots: readonly string[];
  csrfToken: string;
  onConfirmedHighRiskRootsChange: (roots: string[]) => void;
  onWorkspaceRootsChange: (roots: string[]) => void;
  workspaceRoots: readonly string[];
}) {
  const { messages } = useI18n();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [inspections, setInspections] = useState<WorkspaceInspection[]>([]);
  const [inspectionError, setInspectionError] = useState<unknown>();
  const [inspectionBusy, setInspectionBusy] = useState(false);

  useEffect(() => {
    let active = true;
    if (workspaceRoots.length === 0) {
      setInspections([]);
      setInspectionError(undefined);
      setInspectionBusy(false);
      return () => {
        active = false;
      };
    }
    setInspectionBusy(true);
    setInspectionError(undefined);
    void inspectDirectories(csrfToken, workspaceRoots)
      .then((next) => {
        if (active) setInspections(next);
      })
      .catch((error: unknown) => {
        if (active) setInspectionError(error);
      })
      .finally(() => {
        if (active) setInspectionBusy(false);
      });
    return () => {
      active = false;
    };
  }, [csrfToken, workspaceRoots]);

  const closeBrowser = useCallback(() => {
    setBrowserOpen(false);
    requestAnimationFrame(() => addButtonRef.current?.focus());
  }, []);

  const removeRoot = (root: string) => {
    onWorkspaceRootsChange(
      workspaceRoots.filter((candidate) => candidate !== root),
    );
    onConfirmedHighRiskRootsChange(
      confirmedHighRiskRoots.filter((candidate) => candidate !== root),
    );
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-6">
          <div className="space-y-1.5">
            <CardTitle>{messages.configuration.authorizedTitle}</CardTitle>
            <CardDescription>
              {messages.configuration.authorizedDescription}
            </CardDescription>
          </div>
          <button
            className={buttonVariants()}
            disabled={busy}
            onClick={() => setBrowserOpen(true)}
            ref={addButtonRef}
            type="button"
          >
            <Plus aria-hidden="true" className="size-4" />
            {messages.configuration.addDirectory}
          </button>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-slate-900">
                {messages.configuration.authorizedSummary(
                  workspaceRoots.length,
                )}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {messages.configuration.authorizedSummaryDescription}
              </p>
            </div>
            {inspectionBusy ? (
              <span className="text-xs text-slate-500">
                {messages.configuration.inspectingDirectories}
              </span>
            ) : null}
          </div>

          {inspectionError === undefined ? null : (
            <InlineError error={inspectionError} messages={messages} />
          )}

          {workspaceRoots.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 px-6 py-12 text-center">
              <FolderOpen
                aria-hidden="true"
                className="mx-auto size-8 text-slate-400"
              />
              <p className="mt-3 text-sm font-medium text-slate-900">
                {messages.configuration.emptyDirectoriesTitle}
              </p>
              <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-slate-500">
                {messages.configuration.emptyDirectoriesDescription}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-200">
              <table className="w-full table-fixed text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="w-[44%] px-4 py-2.5 font-medium" scope="col">
                      {messages.configuration.pathColumn}
                    </th>
                    <th className="w-[16%] px-4 py-2.5 font-medium" scope="col">
                      {messages.configuration.statusColumn}
                    </th>
                    <th className="w-[28%] px-4 py-2.5 font-medium" scope="col">
                      {messages.configuration.coverageColumn}
                    </th>
                    <th
                      className="w-[12%] px-4 py-2.5 text-right font-medium"
                      scope="col"
                    >
                      {messages.configuration.actionsColumn}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {workspaceRoots.map((root) => {
                    const inspection = inspections.find(
                      (candidate) => candidate.configuredPath === root,
                    );
                    return (
                      <tr key={root}>
                        <td className="px-4 py-3 align-top">
                          <div className="flex min-w-0 items-start gap-2">
                            <Folder
                              aria-hidden="true"
                              className="mt-0.5 size-4 shrink-0 text-slate-400"
                            />
                            <div className="min-w-0">
                              <code className="break-all text-xs text-slate-900">
                                {inspection?.canonicalPath ?? root}
                              </code>
                              {inspection?.highRisk ? (
                                <div className="mt-1.5">
                                  <Badge variant="warning">
                                    <ShieldAlert
                                      aria-hidden="true"
                                      className="mr-1 size-3"
                                    />
                                    {messages.configuration.highRiskBadge}
                                  </Badge>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <WorkspaceStatus
                            inspection={inspection}
                            loading={inspectionBusy}
                            messages={messages}
                          />
                        </td>
                        <td className="px-4 py-3 align-top text-xs leading-5 text-slate-600">
                          {inspection?.coveredBy === undefined
                            ? messages.configuration.directCoverage
                            : messages.configuration.coveredBy(
                                inspection.coveredBy,
                              )}
                        </td>
                        <td className="px-4 py-3 text-right align-top">
                          <Button
                            aria-label={messages.configuration.removeDirectory(
                              root,
                            )}
                            disabled={busy}
                            onClick={() => removeRoot(root)}
                            size="icon"
                            title={messages.configuration.remove}
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {browserOpen ? (
        <DirectoryBrowserDialog
          csrfToken={csrfToken}
          existingInspections={inspections}
          messages={messages}
          onAuthorize={(path, highRisk) => {
            onWorkspaceRootsChange([...workspaceRoots, path]);
            if (highRisk) {
              onConfirmedHighRiskRootsChange([...confirmedHighRiskRoots, path]);
            }
            closeBrowser();
          }}
          onClose={closeBrowser}
          workspaceRoots={workspaceRoots}
        />
      ) : null}
    </>
  );
}

function WorkspaceStatus({
  inspection,
  loading,
  messages,
}: {
  inspection: WorkspaceInspection | undefined;
  loading: boolean;
  messages: TranslationMessages;
}) {
  if (inspection === undefined) {
    return (
      <Badge variant="secondary">
        {loading
          ? messages.configuration.checkingStatus
          : messages.configuration.statusUnknown}
      </Badge>
    );
  }
  return inspection.status === "available" ? (
    <Badge variant="success">{messages.configuration.availableStatus}</Badge>
  ) : (
    <Badge variant="destructive">
      {messages.configuration.unavailableStatus}
    </Badge>
  );
}

function DirectoryBrowserDialog({
  csrfToken,
  existingInspections,
  messages,
  onAuthorize,
  onClose,
  workspaceRoots,
}: {
  csrfToken: string;
  existingInspections: readonly WorkspaceInspection[];
  messages: TranslationMessages;
  onAuthorize: (path: string, highRisk: boolean) => void;
  onClose: () => void;
  workspaceRoots: readonly string[];
}) {
  const addressRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState("");
  const [browserError, setBrowserError] = useState<unknown>();
  const [busy, setBusy] = useState(true);
  const [confirming, setConfirming] = useState<WorkspaceInspection>();
  const [listing, setListing] = useState<DirectoryBrowseResult>();

  const navigate = useCallback(
    async (path?: string) => {
      setBusy(true);
      setBrowserError(undefined);
      try {
        const next = await browseDirectories(csrfToken, path);
        setListing(next);
        setAddress(next.currentPath ?? "");
        setConfirming(undefined);
      } catch (error) {
        setBrowserError(error);
      } finally {
        setBusy(false);
      }
    },
    [csrfToken],
  );

  useEffect(() => {
    void navigate();
  }, [navigate]);

  useEffect(() => {
    addressRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const authorizeCurrent = async () => {
    if (listing?.currentPath === null || listing?.currentPath === undefined) {
      return;
    }
    setBusy(true);
    setBrowserError(undefined);
    try {
      const [inspection] = await inspectDirectories(csrfToken, [
        listing.currentPath,
      ]);
      if (inspection === undefined || inspection.status !== "available") {
        throw new LocalAdminApiError(
          "WORKSPACE_NOT_AVAILABLE",
          messages.configuration.directoryUnavailable,
        );
      }
      const canonicalPath =
        inspection.canonicalPath ?? inspection.configuredPath;
      const duplicate =
        existingInspections.some(
          (candidate) =>
            candidate.canonicalPath !== undefined &&
            sameCanonicalPath(candidate.canonicalPath, canonicalPath),
        ) ||
        workspaceRoots.some((candidate) =>
          sameCanonicalPath(candidate, canonicalPath),
        );
      if (duplicate) {
        throw new LocalAdminApiError(
          "WORKSPACE_ROOT_DUPLICATE",
          messages.configuration.duplicateDirectory,
        );
      }
      if (inspection.highRisk) {
        setConfirming({ ...inspection, canonicalPath });
      } else {
        onAuthorize(canonicalPath, false);
      }
    } catch (error) {
      setBrowserError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const trimmed = address.trim();
    if (trimmed !== "") void navigate(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-8"
      data-testid="directory-browser-backdrop"
    >
      <div
        aria-describedby="directory-browser-description"
        aria-labelledby="directory-browser-title"
        aria-modal="true"
        className="flex max-h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        role="dialog"
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2
              className="text-base font-semibold"
              id="directory-browser-title"
            >
              {confirming === undefined
                ? messages.configuration.browserTitle
                : messages.configuration.highRiskTitle}
            </h2>
            <p
              className="mt-1 text-sm text-slate-500"
              id="directory-browser-description"
            >
              {confirming === undefined
                ? messages.configuration.browserDescription
                : messages.configuration.highRiskDescription}
            </p>
          </div>
          <Button
            aria-label={messages.configuration.closeBrowser}
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>

        {confirming === undefined ? (
          <>
            <div className="space-y-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
              <div className="flex items-end gap-2">
                <label className="min-w-0 flex-1 text-xs font-medium text-slate-700">
                  {messages.configuration.addressLabel}
                  <input
                    className={cn(inputClassName, "mt-1.5 font-mono")}
                    onChange={(event) => setAddress(event.target.value)}
                    onKeyDown={handleAddressKeyDown}
                    placeholder={messages.configuration.addressPlaceholder}
                    ref={addressRef}
                    value={address}
                  />
                </label>
                <Button
                  disabled={busy || address.trim() === ""}
                  onClick={() => void navigate(address.trim())}
                  type="button"
                >
                  {messages.configuration.goToDirectory}
                </Button>
              </div>
              <div className="flex min-h-8 items-center gap-1 overflow-x-auto text-xs">
                <Button
                  disabled={busy}
                  onClick={() => void navigate()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <HardDrive aria-hidden="true" className="size-3.5" />
                  {messages.configuration.rootsAndHome}
                </Button>
                {listing?.currentPath === null || listing === undefined
                  ? null
                  : breadcrumbPaths(listing.currentPath).map((crumb) => (
                      <span
                        className="flex items-center gap-1"
                        key={crumb.path}
                      >
                        <ChevronRight
                          aria-hidden="true"
                          className="size-3 text-slate-400"
                        />
                        <button
                          className="rounded px-1.5 py-1 font-mono text-slate-700 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                          disabled={busy}
                          onClick={() => void navigate(crumb.path)}
                          type="button"
                        >
                          {crumb.label}
                        </button>
                      </span>
                    ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {browserError === undefined ? null : (
                <InlineError error={browserError} messages={messages} />
              )}
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {listing?.currentPath === null
                    ? messages.configuration.rootsAndHome
                    : messages.configuration.directories}
                </p>
                {listing?.parentPath === null ||
                listing === undefined ? null : (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void navigate(listing.parentPath ?? undefined)
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <ChevronUp aria-hidden="true" className="size-3.5" />
                    {messages.configuration.upOneLevel}
                  </Button>
                )}
              </div>
              <div className="overflow-hidden rounded-md border border-slate-200">
                {busy && listing === undefined ? (
                  <p className="px-4 py-10 text-center text-sm text-slate-500">
                    {messages.configuration.loadingDirectories}
                  </p>
                ) : listing?.entries.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-slate-500">
                    {messages.configuration.noSubdirectories}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {listing?.entries.map((entry) => (
                      <li key={entry.path}>
                        <button
                          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={busy || !entry.accessible}
                          onClick={() => void navigate(entry.path)}
                          type="button"
                        >
                          {entry.root ? (
                            <HardDrive
                              aria-hidden="true"
                              className="size-4 text-slate-500"
                            />
                          ) : (
                            <Folder
                              aria-hidden="true"
                              className="size-4 text-amber-500"
                            />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-slate-900">
                              {entry.name}
                            </span>
                            <code className="block truncate text-xs text-slate-500">
                              {entry.path}
                            </code>
                          </span>
                          {!entry.accessible ? (
                            <Badge variant="destructive">
                              {messages.configuration.unavailableStatus}
                            </Badge>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {listing?.truncated ? (
                <p className="mt-3 text-xs text-amber-700" role="status">
                  {messages.configuration.truncatedListing}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4">
              <code className="max-w-[65%] truncate text-xs text-slate-600">
                {listing?.currentPath ?? messages.configuration.selectDirectory}
              </code>
              <div className="flex items-center gap-2">
                <Button onClick={onClose} type="button" variant="outline">
                  {messages.configuration.cancel}
                </Button>
                <Button
                  disabled={busy || listing?.currentPath == null}
                  onClick={() => void authorizeCurrent()}
                  type="button"
                >
                  {messages.configuration.authorizeDirectory}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-5 p-6">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-5">
              <div className="flex items-start gap-3">
                <ShieldAlert
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-amber-700"
                />
                <div>
                  <p className="text-sm font-semibold text-amber-950">
                    {messages.configuration.highRiskWarning}
                  </p>
                  <code className="mt-2 block break-all text-xs text-amber-900">
                    {confirming.canonicalPath ?? confirming.configuredPath}
                  </code>
                  <p className="mt-3 text-xs leading-5 text-amber-800">
                    {messages.configuration.highRiskImpact}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setConfirming(undefined)}
                type="button"
                variant="outline"
              >
                {messages.configuration.backToBrowser}
              </Button>
              <Button
                onClick={() =>
                  onAuthorize(
                    confirming.canonicalPath ?? confirming.configuredPath,
                    true,
                  )
                }
                type="button"
                variant="destructive"
              >
                {messages.configuration.confirmHighRisk}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InlineError({
  error,
  messages,
}: {
  error: unknown;
  messages: TranslationMessages;
}) {
  return (
    <p
      className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      role="alert"
    >
      {formatError(error, messages)}
    </p>
  );
}

function formatError(error: unknown, messages: TranslationMessages): string {
  if (error instanceof LocalAdminApiError) {
    if (error.code === "LOCAL_ADMIN_RESPONSE_INVALID") {
      return messages.errors.invalidResponse;
    }
    if (error.code === "LOCAL_ADMIN_REQUEST_FAILED") {
      return messages.errors.localRequestFailed;
    }
    return error.message;
  }
  return messages.errors.localRequestFailed;
}

function sameCanonicalPath(left: string, right: string): boolean {
  if (isWindowsPath(left) || isWindowsPath(right)) {
    return normalizeWindowsPath(left) === normalizeWindowsPath(right);
  }
  return left === right;
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}

function normalizeWindowsPath(path: string): string {
  return path
    .replaceAll("/", "\\")
    .replace(/[\\]+$/u, "")
    .toLowerCase();
}

function breadcrumbPaths(path: string): Array<{ label: string; path: string }> {
  if (path.startsWith("\\\\")) {
    const segments = path.split(/[\\/]+/u).filter(Boolean);
    if (segments.length < 2) return [{ label: path, path }];
    const root = `\\\\${segments[0]}\\${segments[1]}\\`;
    const crumbs = [
      { label: `\\\\${segments[0]}\\${segments[1]}`, path: root },
    ];
    let current = root;
    for (const segment of segments.slice(2)) {
      current = `${current.replace(/[\\]+$/u, "")}\\${segment}`;
      crumbs.push({ label: segment, path: current });
    }
    return crumbs;
  }
  if (/^[A-Za-z]:[\\/]/u.test(path)) {
    const normalized = path.replaceAll("/", "\\");
    const root = normalized.slice(0, 3);
    const crumbs = [{ label: root, path: root }];
    let current = root;
    for (const segment of normalized.slice(3).split("\\").filter(Boolean)) {
      current = `${current.replace(/[\\]+$/u, "")}\\${segment}`;
      crumbs.push({ label: segment, path: current });
    }
    return crumbs;
  }
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current = `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}
