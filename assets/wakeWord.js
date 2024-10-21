
const {config} = require('dotenv')


const { PvRecorder } = require("@picovoice/pvrecorder-node");
const { Porcupine, BuiltinKeyword } = require("@picovoice/porcupine-node");
const path = require("path")
const { parentPort } = require("worker_threads")

config();
// Testing how to get audio from user

const keywordPath = path.join(__dirname, "Hey-Aida_en_windows_v3_0_0.ppn");
console.log(keywordPath);

class RecorderController {
   accessKey = process.env.ACCESS_KEY;

   model;
   recorder;

  constructor(recorderFrames = 512) {
    try{
      this.model = new Porcupine(this.accessKey, [keywordPath], [0.5]);

    }
    catch (error){
      throw new Error('error, either model file doesnt exist or accessKey not in env')
    }
    this.recorder = new PvRecorder(recorderFrames);
  }

  startRecording = async () => {
    this.recorder.start();

    console.log("I'm listening...")
    while (this.recorder.isRecording) {
      try{
        const frame = await this.recorder.read();
        const keyword = this.model.process(frame);
        if (keyword === 0) {
          parentPort?.postMessage("yes?");
        }
      }
      catch (err){
        console.log('no longer listening');
        break;
      }
    }
  };

  stopRecording = async () => {
    await this.recorder.stop();
  }
}

const recorderController = new RecorderController();


parentPort?.on("message", (msg) => {
  if (msg.action == "start") {
    recorderController.startRecording();
  }
  if (msg.action == "stop"){
    recorderController.stopRecording();
    parentPort.postMessage({response: "closed"})
  }
});



