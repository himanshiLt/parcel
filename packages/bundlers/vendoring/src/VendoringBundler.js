// @flow strict-local

import type {Asset, Bundle} from '@parcel/types';

import invariant from 'assert';
import {Bundler} from '@parcel/plugin';
// import {md5FromString} from '@parcel/utils';
import nullthrows from 'nullthrows';

// const OPTIONS = {
//   minBundles: 1,
//   minBundleSize: 30000,
//   maxParallelRequests: 5
// };

function isVendor(asset: Asset) {
  //TODO Yarn PnP?
  return asset != null ? asset.filePath.includes('node_modules') : false;
}

export default new Bundler({
  // RULES:
  // 0. Keep assets from inside node_modules seperated from 'user code'
  // 1. If dep.isAsync or dep.isEntry, start a new bundle group.
  // 2. If an asset is a different type than the current bundle, make a parallel bundle in the same bundle group.
  // 3. If an asset is already in a parent bundle in the same entry point, exclude from child bundles.
  // 4. If an asset is only in separate isolated entry points (e.g. workers, different HTML pages), duplicate it.

  bundle({bundleGraph}) {
    // Step 1: create bundles for each of the explicit code split points.
    bundleGraph.traverse((node, context) => {
      if (node.type !== 'dependency') {
        return {
          ...context,
          parentNode: node
        };
      }

      let dependency = node.value;
      let assets = bundleGraph.getDependencyAssets(dependency);

      if (dependency.isEntry || dependency.isAsync) {
        let bundleGroup = bundleGraph.createBundleGroup(
          dependency,
          nullthrows(dependency.target ?? context?.bundleGroup?.target)
        );

        let bundleByType = {
          app: new Map<string, Bundle>(),
          vendor: new Map<string, Bundle>()
        };
        for (let asset of assets) {
          let bundle = bundleGraph.createBundle({
            entryAsset: asset,
            isEntry: asset.isIsolated ? false : Boolean(dependency.isEntry),
            target: bundleGroup.target
          });
          bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
          if (dependency.isAsync) {
            bundleGraph.createAssetReference(dependency, asset);
          }
          if (isVendor(asset)) {
            bundleByType.vendor.set(bundle.type, bundle);
          } else {
            bundleByType.app.set(bundle.type, bundle);
          }
        }

        return {
          bundleGroup,
          bundleGroupDependency: dependency,
          bundleByType,
          parentNode: node
        };
      }

      invariant(context != null);
      for (let asset of assets) {
        if (asset.isIsolated) {
          let bundleGroup = bundleGraph.createBundleGroup(
            dependency,
            context.bundleGroup.target
          );
          let bundle = bundleGraph.createBundle({
            entryAsset: asset,
            target: context.bundleGroup.target
          });
          bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
          bundleGraph.createAssetReference(dependency, asset);
        } else {
          invariant(context.parentNode.type === 'asset');
          let parentAsset = context.parentNode.value;
          if (
            parentAsset.type === asset.type &&
            isVendor(parentAsset) === isVendor(asset)
          ) {
            continue;
          }

          let existingBundle = isVendor(asset)
            ? context.bundleByType.vendor.get(asset.type)
            : context.bundleByType.app.get(asset.type);
          let bundle;
          if (existingBundle) {
            bundle = existingBundle;
          } else {
            bundle = bundleGraph.createBundle({
              entryAsset: dependency.isEntry ? asset : null,
              target: context.bundleGroup.target,
              isEntry: context.bundleGroupDependency.isEntry,
              type: asset.type,
              env: asset.env,
              id: asset.id
            });
            bundleGraph.addBundleToBundleGroup(bundle, context.bundleGroup);
            if (isVendor(asset)) {
              context.bundleByType.vendor.set(bundle.type, bundle);
            } else {
              context.bundleByType.app.set(bundle.type, bundle);
            }
          }
          bundleGraph.addAssetToBundle(asset, bundle);
          bundleGraph.createAssetReference(dependency, asset);
        }
      }

      return {
        ...context,
        parentNode: node
      };
    });
  },

  optimize({bundleGraph}) {
    // Step 2: remove assets that are duplicated in a parent bundle
    bundleGraph.traverseBundles({
      exit(bundle) {
        if (bundle.env.isIsolated()) {
          // If a bundle's environment is isolated, it can't access assets present
          // in any ancestor bundles. Don't deduplicate any assets.
          return;
        }
        bundle.traverse(node => {
          if (node.type !== 'dependency') {
            return;
          }
          let dependency = node.value;
          let assets = bundleGraph.getDependencyAssets(dependency);
          for (let asset of assets) {
            if (bundleGraph.isAssetInAncestorBundles(bundle, asset)) {
              bundleGraph.createAssetReference(dependency, asset);
              bundleGraph.removeAssetGraphFromBundle(asset, bundle);
            }
          }
        });
      }
    });
    // // Step 3: Find duplicated assets in different bundle groups, and separate them into their own parallel bundles.
    // // If multiple assets are always seen together in the same bundles, combine them together.
    // let candidateBundles: Map<
    //   string,
    //   {|
    //     assets: Array<Asset>,
    //     sourceBundles: Set<Bundle>,
    //     size: number
    //   |}
    // > = new Map();
    // bundleGraph.traverseContents((node, ctx, actions) => {
    //   if (node.type !== 'asset') {
    //     return;
    //   }
    //   let asset = node.value;
    //   if (asset.env.isIsolated()) {
    //     // If an asset's environment is isolated, it can't load shared bundles.
    //     // Don't add this asset to a shared bundle.
    //     return;
    //   }
    //   let containingBundles = bundleGraph
    //     .findBundlesWithAsset(asset)
    //     // Don't create shared bundles from entry bundles, as that would require
    //     // another entry bundle depending on these conditions, making it difficult
    //     // to predict and reference.
    //     .filter(b => !b.isEntry);
    //   if (containingBundles.length > OPTIONS.minBundles) {
    //     let id = containingBundles
    //       .map(b => b.id)
    //       .sort()
    //       .join(':');
    //     let candidate = candidateBundles.get(id);
    //     if (candidate) {
    //       candidate.assets.push(asset);
    //       for (let bundle of containingBundles) {
    //         candidate.sourceBundles.add(bundle);
    //       }
    //       candidate.size += bundleGraph.getTotalSize(asset);
    //     } else {
    //       candidateBundles.set(id, {
    //         assets: [asset],
    //         sourceBundles: new Set(containingBundles),
    //         size: bundleGraph.getTotalSize(asset)
    //       });
    //     }
    //     // Skip children from consideration since we added a parent already.
    //     actions.skipChildren();
    //   }
    // });
    // // Sort candidates by size (consider larger bundles first), and ensure they meet the size threshold
    // let sortedCandidates: Array<{|
    //   assets: Array<Asset>,
    //   sourceBundles: Set<Bundle>,
    //   size: number
    // |}> = Array.from(candidateBundles.values())
    //   .filter(bundle => bundle.size >= OPTIONS.minBundleSize)
    //   .sort((a, b) => b.size - a.size);
    // for (let {assets, sourceBundles} of sortedCandidates) {
    //   // Find all bundle groups connected to the original bundles
    //   let bundleGroups = new Set();
    //   for (let bundle of sourceBundles) {
    //     for (let bundleGroup of bundleGraph.getBundleGroupsContainingBundle(
    //       bundle
    //     )) {
    //       bundleGroups.add(bundleGroup);
    //     }
    //   }
    //   // Check that all the bundle groups are inside the parallel request limit.
    //   if (
    //     Array.from(bundleGroups).some(
    //       group =>
    //         bundleGraph.getBundlesInBundleGroup(group).length >=
    //         OPTIONS.maxParallelRequests
    //     )
    //   ) {
    //     continue;
    //   }
    //   let [firstBundle] = [...sourceBundles];
    //   let sharedBundle = bundleGraph.createBundle({
    //     id: md5FromString([...sourceBundles].map(b => b.id).join(':')),
    //     env: firstBundle.env,
    //     target: firstBundle.target,
    //     type: firstBundle.type
    //   });
    //   // Remove all of the root assets from each of the original bundles
    //   for (let asset of assets) {
    //     bundleGraph.addAssetGraphToBundle(asset, sharedBundle);
    //     for (let bundle of sourceBundles) {
    //       bundleGraph.removeAssetGraphFromBundle(asset, bundle);
    //       for (let dependency of bundleGraph.getDependenciesInBundle(
    //         bundle,
    //         asset
    //       )) {
    //         bundleGraph.createAssetReference(dependency, asset);
    //       }
    //     }
    //   }
    //   // Create new bundle node and connect it to all of the original bundle groups
    //   for (let bundleGroup of bundleGroups) {
    //     bundleGraph.addBundleToBundleGroup(sharedBundle, bundleGroup);
    //   }
    // }
  }
});
