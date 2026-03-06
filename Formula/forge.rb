class Forge < Formula
  desc "Project orchestration for Claude Code, backed by beads"
  homepage "https://github.com/MonsieurBarti/forgeflow"
  url "https://github.com/MonsieurBarti/forgeflow/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "4fced6b0d4f284307158d8fdc348539d4a29d2fdb6079f1dc0f59a00dfc7501b"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    bin.write_exec_script libexec/"install.js"
  end

  def caveats
    <<~EOS
      Run the installer to set up Forge in Claude Code:
        node #{libexec}/install.js
    EOS
  end

  test do
    assert_match "Forge", shell_output("node #{libexec}/install.js --help 2>&1", 1)
  end
end
