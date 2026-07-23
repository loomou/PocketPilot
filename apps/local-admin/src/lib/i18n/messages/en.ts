export const en = {
  common: {
    local: "Local",
    none: "-",
    statuses: {
      failed: "Failed",
      paired: "Paired",
      pending: "Pending",
      revoked: "Revoked",
      success: "Success",
    },
  },
  shell: {
    brandSubtitle: "Local administration console",
    loadingAgent: "Loading local Agent",
    languageLabel: "Interface language",
    loadingStatus: "Loading",
    localAccessDescription:
      "This console is accessible only through the local administration listener.",
    localAccessTitle: "Local access only",
    navigationLabel: "Administration console navigation",
    nav: {
      audit: "Audit records",
      configuration: "Configuration",
      devices: "Devices",
      maintenance: "Maintenance",
      overview: "Overview",
    },
    refresh: "Refresh",
    refreshAria: "Refresh local administration data",
    runningAgent: "Local Agent running",
    runningStatus: "Running",
    section: {
      audit: {
        description:
          "Inspect audit metadata for local control, configuration, and security events.",
        title: "Audit records",
      },
      configuration: {
        description:
          "Adjust runtime endpoints, workspace access, and task capacity.",
        title: "Configuration",
      },
      devices: {
        description:
          "Pair trusted mobile devices and manage existing device access.",
        title: "Devices",
      },
      maintenance: {
        description:
          "View security metadata and terminal-only recovery guidance.",
        title: "Maintenance",
      },
      overview: {
        description:
          "Check Agent health, current policy, devices, and recent activity.",
        title: "Overview",
      },
    },
  },
  overview: {
    activeDevices: "Active devices",
    activeDevicesDetail: (count: number) => `${count} revoked`,
    agentCode: (code: string) => `Agent verification code ${code}`,
    agentDescription:
      "Current listener and the mobile entry point published by the server.",
    agentStatus: "Agent status",
    agentOverviewAria: "Agent overview",
    deviceApprovalDescription:
      "Verify the six-digit codes on both sides before granting access.",
    emptyAudits: "No audit records yet.",
    emptyPairings: "There are no devices waiting for approval.",
    expiry: (timestamp: string) => `Expires ${timestamp}`,
    localAdminListener: "Local administration listener",
    mobileBaseUrl: "Mobile base URL",
    mobileBaseUrlMissing: "Not configured for this start",
    manageDevices: "Manage devices",
    maxConcurrentTasks: "Maximum concurrent tasks",
    noPendingPairings: "There are no devices waiting for approval.",
    openConfiguration: "Open configuration",
    pairingPending: "Pending pairings",
    pairingPendingDetail: "Waiting for local approval",
    policyDescription: "Current runtime configuration and task limits.",
    recentActivity: "Recent activity",
    recentActivityDescription:
      "Latest local audit records returned by the Agent.",
    revokedDevices: "Revoked",
    running: "Running",
    serverListener: "Remote listener",
    statusSummary: "Runtime status",
    table: {
      time: "Time",
      operation: "Operation",
      device: "Device",
      result: "Result",
    },
    viewAllRecords: "View all records",
    workspaceRoots: "Workspace roots",
    workspaceRootsCount: (count: number) => String(count),
    online: "Online",
  },
  configuration: {
    discardChanges: "Discard changes",
    dirtyDescription:
      "Save runtime settings and task policy together, or discard these changes.",
    dirtyTitle: "Unsaved configuration changes.",
    hostLabel: "Remote listener host",
    mobileBaseUrl: "Mobile base URL",
    mobileBaseUrlDescription:
      "This address is written into the server-generated QR code and provided to mobile devices.",
    portLabel: "Port",
    runtimeDescription:
      "Listener changes take effect the next time the Agent starts.",
    runtimeSettings: "Runtime settings",
    saveChanges: "Save configuration",
    taskDescription:
      "Limit concurrent tasks and the directories that tasks can access.",
    taskSettings: "Task policy",
    concurrentDescription:
      "Maximum number of tasks the Agent can run at the same time.",
    concurrentLabel: "Maximum concurrent tasks",
    workspaceRootsDescription: "Enter one absolute workspace path per line.",
    workspaceRootsLabel: "Workspace roots",
    requireApprovalLabel: "Require approval for shell tools",
    autoLockLabel: "Auto-lock when idle",

    configurationTabs: "Configuration tabs",
    generalTab: "General",
    authorizedTab: "Authorized directories",
    authorizedTitle: "Authorized directories",
    authorizedDescription:
      "Choose the local directories that Claude tasks may use. Changes remain a draft until you save.",
    addDirectory: "Add directory",
    authorizedSummary: (count: number) =>
      `${count} configured ${count === 1 ? "directory" : "directories"}`,
    authorizedSummaryDescription:
      "Only available directories can authorize new work; saved unavailable rows remain visible until removed.",
    inspectingDirectories: "Checking directories?",
    emptyDirectoriesTitle: "No authorized directories",
    emptyDirectoriesDescription:
      "Add a directory to let Claude tasks work there. The browser only returns directory metadata.",
    pathColumn: "Path",
    statusColumn: "Status",
    coverageColumn: "Scope / coverage",
    actionsColumn: "Actions",
    highRiskBadge: "High risk",
    directCoverage: "Explicit root",
    coveredBy: (path: string) => `Covered by ${path}`,
    remove: "Remove",
    removeDirectory: (path: string) => `Remove ${path}`,
    availableStatus: "Available",
    unavailableStatus: "Unavailable",
    checkingStatus: "Checking?",
    statusUnknown: "Unknown",
    browserTitle: "Choose a directory",
    browserDescription:
      "Navigate directories available to the local Agent. Files and file contents are never shown.",
    closeBrowser: "Close directory browser",
    addressLabel: "Absolute path",
    addressPlaceholder: "C:\\work or /work",
    goToDirectory: "Go",
    rootsAndHome: "Roots and home",
    directories: "Directories",
    upOneLevel: "Up",
    loadingDirectories: "Loading directories?",
    noSubdirectories: "No accessible subdirectories",
    truncatedListing:
      "This listing is truncated. Use the address bar to navigate deeper.",
    selectDirectory: "Select a directory to authorize",
    cancel: "Cancel",
    authorizeDirectory: "Authorize directory",
    highRiskTitle: "Confirm high-risk directory",
    highRiskDescription:
      "This directory is a filesystem, volume, or UNC share root.",
    highRiskWarning:
      "Authorizing a filesystem root grants access to a very broad area.",
    highRiskImpact:
      "Only confirm this when the broad scope is intentional. The directory will remain marked as high risk.",
    backToBrowser: "Back",
    confirmHighRisk: "Confirm and authorize",
    directoryUnavailable: "This directory is not currently available.",
    duplicateDirectory: "This directory is already configured.",
  },
  devices: {
    active: "Paired",
    approvalCode: "Mobile verification code",
    approvalCodeAria: (name: string) => `Mobile verification code for ${name}`,
    approve: "Approve",
    approveDescription:
      "Confirm that the Agent code matches the code shown on the mobile device.",
    cancel: "Cancel",
    closeDialog: "Close dialog",
    createdAt: "Paired at",
    deviceSummary: "Device summary",
    deviceList: "Device list",
    deviceListDescription:
      "After revocation, the selected device session expires immediately.",
    expiredAt: "Expires at",
    generatePairing: "Generate pairing QR code",
    generatePairingDescription:
      "Generate a server-issued QR code, then verify and approve the matching six-digit code.",
    pairingDataDescription:
      "Pairing QR data is returned by the local Agent, expires after five minutes, and can register only one device.",
    pairingDataSafety: "The browser does not construct or persist this data.",
    pairingId: "Pairing ID",
    pairingNew: "Pair a new device",
    pendingApproval: "Pending approval",
    pendingApprovalDescription:
      "Confirm that the Agent code matches the code shown on the mobile device.",
    revoke: "Revoke",
    revokeAccess: "Revoke access",
    revokeAria: (name: string) => `Revoke access for ${name}`,
    revokeConfirmTitle: "Revoke device access?",
    revokeDescription:
      "This immediately expires the device session and cannot be undone in the browser.",
    qrAlt: "PocketPilot device pairing QR code",
    qrDescription:
      "Use the PocketPilot mobile app to scan the server-issued QR code.",
    qrStaticDescription:
      "These are static pairing values returned by the server. PocketPilot does not save the QR code or generate any identifiers shown here.",
    revoked: "Revoked",
    summaries: {
      paired: "Paired",
      pending: "Pending approval",
      revoked: "Revoked",
    },
    emptyPending: "There are no devices waiting for approval.",
    emptyDevices: "No devices have been paired yet.",
  },
  audit: {
    title: "Audit records",
    description:
      "Search operation, result, device, and task metadata in the current Agent snapshot.",
    searchAria: "Search audit records",
    searchPlaceholder: "Search operations, devices, or task IDs…",
    filterLabel: "Filter audit records by result",
    allResults: "All results",
    resetFilters: "Reset filters",
    empty: "No audit records",
    noMatches: "No matching audit records",
    emptyDescription:
      "The local Agent has not returned any retained audit metadata.",
    noMatchesDescription:
      "Try another search term or reset the current result filter.",
    loading: "Loading audit records",
    loadingDescription: "Requesting the current audit page from the Agent.",
    loadFailed: "Unable to load audit records",
    loadFailedDescription:
      "The audit request failed. Refresh or try again shortly.",
    previousPage: "Previous",
    nextPage: "Next",
    table: {
      time: "Time",
      operation: "Operation",
      tool: "Tool",
      device: "Device",
      task: "Task",
      result: "Result",
    },
    local: "Local",
    summary: (total: number, pageStart: number, pageEnd: number) =>
      total === 0
        ? "No records match."
        : `Showing ${pageStart}–${pageEnd} of ${total} records.`,
  },
  maintenance: {
    metadataTitle: "Security metadata",
    metadataDescription:
      "Runtime information visible to this local browser console.",
    localOnly: "Local only",
    localAdminListener: "Local administration listener",
    remoteListener: "Remote listener",
    activePairings: "Active paired devices",
    retainedAudits: "Retained audit records",
    preflightTitle: "Preflight checks",
    preflightDescription:
      "Key operations are allowed only outside the browser.",
    stepOne: "Stop the Agent before accessing storage.",
    stepTwo:
      "Set the required master-key environment variables in a local terminal.",
    stepThree:
      "Run the command locally, then restart the Agent and refresh this console.",
    terminalTitle: "Terminal-only key maintenance",
    terminalDescription:
      "The following commands are guidance only. This page cannot execute commands or access key material.",
    stopAgentTitle: "Stop the Agent before continuing.",
    stopAgentDescription:
      "Maintenance operations require an exclusive storage lock; the Agent rejects them while running.",
    rotateDescription:
      "Provide the current AGENT_MASTER_KEY and a different AGENT_NEW_MASTER_KEY, then re-encrypt sensitive records managed by the Agent.",
    rotateLabel: "Rotate known master key",
    resetDescription:
      "Use only after losing the master key. This removes device and task metadata managed by the Agent; external credentials and sessions are unaffected.",
    resetLabel: "Reset Agent-managed data",
  },
  notices: {
    configurationSaved:
      "Configuration saved. Listener changes take effect the next time the Agent starts.",
    pairingQrGenerated: "Pairing QR code generated.",
    pairingApproved: "Device pairing approved.",
    deviceRevoked: "Device access revoked.",
  },
  errors: {
    invalidResponse: "The local Agent returned an invalid response.",
    localRequestFailed: "The local administration request failed.",
    loadingFailed: "Local Agent data is temporarily unavailable",
    loadingDescriptionFailed:
      'The console shell is still available. Click "Refresh" when the local Agent is ready.',
    loadingDescription:
      "Reading configuration, status, devices, pairings, and audit records.",
  },
} as const;
