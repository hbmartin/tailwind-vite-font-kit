export const fontAssetPattern = /\.woff2?(?:\?|$)/

export const assetEvidence = (path, type, sourceHash, servedHash = sourceHash) => ({
  path,
  type,
  sourceHash,
  servedHash,
})
