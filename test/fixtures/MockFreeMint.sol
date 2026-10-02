// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Payable mint used to test the free-mint scanner end to end.
contract MockFreeMint {
    string public name = "Mock Free Mint";
    string public symbol = "FREE";
    uint256 public mintPrice;
    uint256 public maxSupply = 1000;
    uint256 public totalMinted;
    uint256 public maxPerWallet = 5;
    bool public saleIsActive = true;
    bool public paused;

    event Minted(address indexed to, uint256 qty);

    function setPrice(uint256 p) external {
        mintPrice = p;
    }

    function setActive(bool a) external {
        saleIsActive = a;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setMaxSupply(uint256 s) external {
        maxSupply = s;
    }

    function mint(uint256 qty) external payable {
        require(!paused, "paused");
        require(saleIsActive, "inactive");
        require(msg.value == mintPrice * qty, "wrong price");
        require(totalMinted + qty <= maxSupply, "sold out");
        require(balanceOf[msg.sender] + qty <= maxPerWallet, "per wallet");
        totalMinted += qty;
        balanceOf[msg.sender] += qty;
        emit Minted(msg.sender, qty);
    }

    mapping(address => uint256) public balanceOf;

    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }
}
