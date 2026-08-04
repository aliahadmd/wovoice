import './index.css';
import {Composition, Folder} from 'remotion';
import {WoVoiceMarketingVideo} from './Composition';
import {AccuracyScene} from './scenes/AccuracyScene';
import {BrandScene} from './scenes/BrandScene';
import {DashboardScene} from './scenes/DashboardScene';
import {ManualScene} from './scenes/ManualScene';
import {OutroScene} from './scenes/OutroScene';
import {VoiceScene} from './scenes/VoiceScene';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="WoVoice-Marketing"
        component={WoVoiceMarketingVideo}
        durationInFrames={750}
        fps={30}
        width={1920}
        height={1080}
      />
      <Folder name="Scenes">
        <Composition id="Brand" component={BrandScene} durationInFrames={105} fps={30} width={1920} height={1080} />
        <Composition id="Voice" component={VoiceScene} durationInFrames={195} fps={30} width={1920} height={1080} />
        <Composition id="Accuracy" component={AccuracyScene} durationInFrames={135} fps={30} width={1920} height={1080} />
        <Composition id="Manual" component={ManualScene} durationInFrames={120} fps={30} width={1920} height={1080} />
        <Composition id="Dashboard" component={DashboardScene} durationInFrames={150} fps={30} width={1920} height={1080} />
        <Composition id="Outro" component={OutroScene} durationInFrames={120} fps={30} width={1920} height={1080} />
      </Folder>
    </>
  );
};
