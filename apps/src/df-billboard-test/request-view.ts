import type { PostRequest } from "./l1-request-core";

export type RequestJobView = Pick<
  PostRequest,
  "commitment" | "text" | "l1Tx" | "l2Tx" | "l2Attempted" | "postId"
>;
export interface RequestView {
  available: boolean;
  payer: string;
  jobs: RequestJobView[];
}
export const emptyRequestView: RequestView = {
  available: false,
  payer: "",
  jobs: [],
};
