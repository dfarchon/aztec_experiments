import type { PostRequest } from "./l1-request-core";

export type RequestJobView = Pick<
  PostRequest,
  "text" | "l1Tx" | "l2Tx" | "l2Attempted"
>;
export interface RequestView {
  available: boolean;
  payer: string;
  pending: RequestJobView | null;
}
export const emptyRequestView: RequestView = {
  available: false,
  payer: "",
  pending: null,
};
