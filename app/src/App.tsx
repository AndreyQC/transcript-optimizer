import { Toolbar } from "./components/Toolbar";
import { DictionaryTabs } from "./components/DictionaryTabs";
import { YamlEditor } from "./components/YamlEditor";
import "./App.css";

function App() {
  return (
    <div className="app-root">
      <Toolbar />
      <DictionaryTabs />
      <div className="editor-pane">
        <YamlEditor />
      </div>
    </div>
  );
}

export default App;
