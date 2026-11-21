export type UpdateState = {
  currentVersion: string;
  nextVersion?: string;
  notes?: string;
  feedUrl: string;
  autoCheck: boolean;
  phase:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  message: string;
  downloaded: number;
  total: number;
};
