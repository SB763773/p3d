import { useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { normalizeModel } from '@/lib/normalizeModel';
import type { SceneObject } from '@/store/useSceneStore';

interface ModelObjectProps {
  object: SceneObject;
  wireframe: boolean;
  selected: boolean;
  onMeasured: (assetKey: string, ratio: [number, number, number], faceCount: number) => void;
  /** 把承载变换的 group 暴露给画布：TransformControls 需要挂到具体的 Object3D 上 */
  onHandle: (id: string, handle: THREE.Object3D | null) => void;
  onSelect: (id: string) => void;
}

/**
 * 单个模型的加载与规范化。
 *
 * 生成模型的三个通病在这里统一处理（方案 §7.2）：
 * 1. 法线朝向不一致 → 面片黑洞：material.side = DoubleSide
 * 2. 重复顶点 → 裂缝：渲染侧关掉 flatShading 掩盖
 * 3. 尺寸任意 → 无法与别的模型共处一室：归一化到最长边 1、底面贴地
 */
export function ModelObject({
  object,
  wireframe,
  selected,
  onMeasured,
  onHandle,
  onSelect,
}: ModelObjectProps) {
  const { scene } = useGLTF(object.assetKey);
  const groupRef = useRef<THREE.Group>(null);

  const { model, ratio, faceCount, materials } = useMemo(() => {
    // clone(true) 会共享 geometry / material 引用，所以材质要单独克隆，
    // 否则切换线框会污染所有引用同一 GLB 的对象
    const cloned = scene.clone(true);
    const materialClones: THREE.Material[] = [];

    cloned.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const source = mesh.material;
      if (Array.isArray(source)) {
        const copies = source.map((item) => item.clone());
        mesh.material = copies;
        materialClones.push(...copies);
      } else if (source) {
        const copy = source.clone();
        mesh.material = copy;
        materialClones.push(copy);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    const transform = normalizeModel(cloned);

    let faces = 0;
    cloned.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geometry = mesh.geometry;
      faces += geometry.index
        ? geometry.index.count / 3
        : (geometry.attributes.position?.count ?? 0) / 3;
    });

    return {
      model: cloned,
      ratio: transform.ratio,
      faceCount: Math.round(faces),
      materials: materialClones,
    };
  }, [scene]);

  // 线框 / 双面渲染：每次 material 变化都重新套一遍
  useEffect(() => {
    for (const material of materials) {
      const mat = material as THREE.MeshStandardMaterial;
      if ('wireframe' in mat) mat.wireframe = wireframe;
      // 生成模型常见法线反了 → 背面剔除后会出现黑洞，双面渲染兜住
      mat.side = THREE.DoubleSide;
      mat.flatShading = false;
      mat.needsUpdate = true;
    }
  }, [materials, wireframe]);

  // 材质是克隆出来的，卸载时自己收尾
  useEffect(() => {
    return () => {
      for (const material of materials) material.dispose();
    };
  }, [materials]);

  useEffect(() => {
    onMeasured(object.assetKey, ratio, faceCount);
  }, [object.assetKey, ratio, faceCount, onMeasured]);

  // 注册/注销可被 TransformControls 操作的节点
  useEffect(() => {
    onHandle(object.id, groupRef.current);
    return () => onHandle(object.id, null);
  }, [object.id, onHandle]);

  // 光圈贴着模型的水平投影做，别做成一圈大呼啦圈
  const ringRadius = Math.max(0.28, Math.max(ratio[0], ratio[2]) * 0.6);

  return (
    <group
      ref={groupRef}
      position={object.position}
      rotation={object.rotation}
      scale={object.scale}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(object.id);
      }}
      onPointerOver={() => {
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      <primitive object={model} />
      {selected ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
          <ringGeometry args={[ringRadius, ringRadius + 0.015, 64]} />
          <meshBasicMaterial color="#2563eb" transparent opacity={0.9} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
    </group>
  );
}

export function ModelObjectFallback() {
  return (
    <mesh position={[0, 0.35, 0]} castShadow>
      <boxGeometry args={[0.6, 0.7, 0.6]} />
      <meshStandardMaterial color="#d4d4d8" wireframe />
    </mesh>
  );
}
