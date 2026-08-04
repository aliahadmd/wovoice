import {Audio} from '@remotion/media';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {AbsoluteFill, Sequence, staticFile} from 'remotion';
import {AccuracyScene} from './scenes/AccuracyScene';
import {BrandScene} from './scenes/BrandScene';
import {DashboardScene} from './scenes/DashboardScene';
import {ManualScene} from './scenes/ManualScene';
import {OutroScene} from './scenes/OutroScene';
import {VoiceScene} from './scenes/VoiceScene';

const Sfx: React.FC = () => {
  return (
    <>
      <Sequence from={5} durationInFrames={40} layout="none">
        <Audio src={staticFile('sfx/switch.wav')} volume={0.55} />
      </Sequence>
      {[88, 269, 389, 494, 629].map((from) => (
        <Sequence
          key={from}
          from={from}
          durationInFrames={30}
          layout="none"
        >
          <Audio src={staticFile('sfx/whoosh.wav')} volume={0.45} />
        </Sequence>
      ))}
      <Sequence from={132} durationInFrames={20} layout="none">
        <Audio src={staticFile('sfx/mouse-click.wav')} volume={0.7} />
      </Sequence>
      <Sequence from={423} durationInFrames={30} layout="none">
        <Audio src={staticFile('sfx/switch.wav')} volume={0.5} />
      </Sequence>
      <Sequence from={679} durationInFrames={65} layout="none">
        <Audio src={staticFile('sfx/ding.wav')} volume={0.45} />
      </Sequence>
    </>
  );
};

export const WoVoiceMarketingVideo: React.FC = () => {
  return (
    <AbsoluteFill>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={105} name="Brand">
          <BrandScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={slide({direction: 'from-right'})}
          timing={linearTiming({durationInFrames: 15})}
        />
        <TransitionSeries.Sequence durationInFrames={195} name="Voice workflow">
          <VoiceScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({durationInFrames: 15})}
        />
        <TransitionSeries.Sequence durationInFrames={135} name="Accuracy">
          <AccuracyScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={slide({direction: 'from-bottom'})}
          timing={linearTiming({durationInFrames: 15})}
        />
        <TransitionSeries.Sequence durationInFrames={120} name="Manual keyboard">
          <ManualScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({durationInFrames: 15})}
        />
        <TransitionSeries.Sequence durationInFrames={150} name="Dashboard">
          <DashboardScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={slide({direction: 'from-right'})}
          timing={linearTiming({durationInFrames: 15})}
        />
        <TransitionSeries.Sequence durationInFrames={120} name="Outro">
          <OutroScene />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Sfx />
    </AbsoluteFill>
  );
};
