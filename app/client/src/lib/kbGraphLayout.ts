/* The knowledge-base graph's force layout lives in app/shared (obj 900867) so
   the server can lay a workspace's graph out once and send the positions with
   it — the browser and the server run the very same code. */
export * from '../../../shared/kb-graph-layout'
