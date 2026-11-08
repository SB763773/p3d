import { ContactShadows, Environment, Grid, Lightformer, OrbitControls } from '@react-three/drei';
import type { RefObject } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { RenderProfile } from '@/lib/deviceTier';
import type { EnvPreset } from '@/store/useSceneStore';

/**
 * 场景静态部分：环境、光照、地面、阴影。
 *
 * 配方不追求炫技，追求"模型看起来对"（方案 §7.3）。三点布光 + 环境贴图 + 接触阴影
 * 是最稳的组合：接触阴影比真实阴影贴图便宜得多，也不会在简陋模型上暴露缺陷。
 */

/** 三个预设只是光板的颜色/强度不同，都不需要下载任何素材 */
interface EnvRig {
  key: { intensity: number; color: string };
  fill: { intensity: number; color: string };
  rim: { intensity: number; color: string };
}

const STUDIO: EnvRig = {
  key: { intensity: 2.4, color: '#ffffff' },
  fill: { intensity: 0.9, color: '#e4e4e7' },
  rim: { intensity: 0.7, color: '#f4f4f5' },
};

const ENV_RIGS: Record<Exclude<EnvPreset, 'none'>, EnvRig> = {
  studio: STUDIO,
  sunset: {
    key: { intensity: 2.6, color: '#ffd9a8' },
    fill: { intensity: 0.7, color: '#ff9e6d' },
    rim: { intensity: 0.9, color: '#8fb4ff' },
  },
  dawn: {
    key: { intensity: 2.2, color: '#ffe8f0' },
    fill: { intensity: 0.8, color: '#c7d2fe' },
    rim: { intensity: 0.8, color: '#ffffff' },
  },
};

interface SceneRigProps {
  profile: RenderProfile;
  envPreset: EnvPreset;
  showGrid: boolean;
  controlsRef: RefObject<OrbitControlsImpl | null>;
}

export function SceneRig({ profile, envPreset, showGrid, controlsRef }: SceneRigProps) {
  const useEnv = profile.envPreset && envPreset !== 'none';
  const rig = envPreset === 'none' ? STUDIO : ENV_RIGS[envPreset];

  return (
    <>
      {/*
        环境光照用**程序化光板**，不用 drei 的 `preset`。
        原因很简单：`preset` 会去 raw.githack.com 拉 HDR，那个域名在国内经常连不上。
        一旦拉不到，Environment 就一直挂起，React 会把整个画布 hidden 掉
        —— 也就是"网络不好 = 3D 完全看不见"。光板方案零外部请求，效果也够用。
      */}
      {useEnv && (
        <Environment resolution={256} frames={1} background={false}>
          <Lightformer
            form="rect"
            intensity={rig.key.intensity}
            color={rig.key.color}
            position={[0, 3, 2.5]}
            scale={[7, 3, 1]}
          />
          <Lightformer
            form="rect"
            intensity={rig.fill.intensity}
            color={rig.fill.color}
            position={[-4.5, 1.2, -2]}
            scale={[4, 3, 1]}
          />
          <Lightformer
            form="rect"
            intensity={rig.rim.intensity}
            color={rig.rim.color}
            position={[4.5, 1.5, -2.5]}
            scale={[4, 3, 1]}
          />
          {/* 底部反光板：让模型下缘不至于死黑 */}
          <Lightformer
            form="circle"
            intensity={0.45}
            color="#ffffff"
            position={[0, -3, 0]}
            scale={[7, 7, 1]}
          />
        </Environment>
      )}

      {/* 环境光兜底：低配设备没有环境贴图时，不能让背光面全黑 */}
      <ambientLight intensity={useEnv ? 0.18 : 0.65} />
      <hemisphereLight args={['#ffffff', '#a1a1aa', useEnv ? 0.22 : 0.55]} />

      {/* 主光 */}
      <directionalLight
        position={[4, 6, 3]}
        intensity={profile.tier === 'low' ? 2.2 : 1.85}
        castShadow={profile.shadows}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={0.1}
        shadow-camera-far={20}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
        shadow-bias={-0.0005}
      />
      {/* 补光：压低强度，只负责拉开背面的层次 */}
      <directionalLight position={[-4, 2, -3]} intensity={0.55} />

      {showGrid ? (
        <Grid
          position={[0, -0.002, 0]}
          args={[12, 12]}
          cellSize={0.25}
          cellThickness={0.6}
          cellColor="#d4d4d8"
          sectionSize={1}
          sectionThickness={1}
          sectionColor="#a1a1aa"
          fadeDistance={24}
          fadeStrength={1.2}
          infiniteGrid
        />
      ) : null}

      {profile.shadows ? (
        <ContactShadows
          position={[0, -0.001, 0]}
          opacity={0.45}
          scale={8}
          blur={2.4}
          far={3}
          resolution={512}
          color="#3f3f46"
        />
      ) : null}

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={0.35}
        maxDistance={12}
        maxPolarAngle={profile.maxPolarAngle}
      />
    </>
  );
}
