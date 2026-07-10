import { Toolbar } from "./components/Toolbar";
import { DictionaryTabs } from "./components/DictionaryTabs";
import { YamlEditor } from "./components/YamlEditor";
import { EditPanel } from "./components/EditPanel";
import "./App.css";

function App() {
  return (
    <div className="app-root">
      <Toolbar />
      <DictionaryTabs />
      <div className="main-pane">
        <div className="editor-pane">
          <YamlEditor />
        </div>
        <EditPanel />
      </div>
    </div>
  );
}

export default App;
