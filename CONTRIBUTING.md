# Contributing to CardCast

Thank you for your interest in contributing to CardCast! We welcome contributions from the TCG streaming community.

## How to Contribute

### Reporting Bugs
1. Check if the issue already exists in [GitHub Issues](https://github.com/yzRobo/CardCast/issues)
2. Create a new issue with:
   - Clear title describing the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Your system info (Windows version, Node.js version)
   - Screenshots if applicable

### Suggesting Features
1. Check existing issues for similar suggestions
2. Create a new issue labeled "enhancement"
3. Describe the feature and why it would be useful
4. Include mockups or examples if possible

### Contributing Code

#### Setup Development Environment
```bash
# Fork and clone the repository
git clone https://github.com/yzRobo/CardCast.git
cd cardcast

# Install dependencies
npm install

# Start development server
npm run dev
```

#### Development Workflow
1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Make your changes
3. Test thoroughly
4. Commit with clear messages: `git commit -m "Add: feature description"`
5. Push to your fork: `git push origin feature/your-feature-name`
6. Create a Pull Request

#### Code Style
- Use 4 spaces for indentation (not tabs)
- Use meaningful variable names
- Add comments for complex logic
- Follow existing code patterns

#### Commit Message Format
- `Add:` for new features
- `Fix:` for bug fixes
- `Update:` for changes to existing features
- `Remove:` for removing features or files
- `Docs:` for documentation changes

### Adding New TCG Support

To add support for a new TCG:

1. **Update configuration** in `config.json`:
```json
"newgame": {
  "enabled": true,
  "dataPath": null,
  "available": false  // Set to true when ready
}
```

2. **Add to TCGCSV API** in `src/tcg-api.js`:
```javascript
this.categories = {
  // ... existing games
  newgame: { id: XX, name: 'Game Name' }
};
```

3. **Add game colors** in `public/js/main.js`:
```javascript
const gameColors = {
  // ... existing colors
  newgame: 'bg-gradient-to-br from-color-500 to-color-600'
};
```

4. **Create data scraper** for the game's cards
5. **Test thoroughly** with real card data
6. **Update documentation** to reflect new game support

### Priority Areas

We especially need help with:
- **TCG Data Integration**: Adding support for more games
- **Overlay Designs**: Creating new OBS overlay templates
- **Performance**: Optimizing search and database queries
- **Testing**: Finding and fixing bugs
- **Documentation**: Improving guides and tutorials

### Testing

Before submitting a PR:
1. Run `npm test` to check the setup
2. Test all major features:
   - Card search
   - OBS overlays
   - Deck import/export
   - Download functionality
3. Test on a clean installation
4. Verify it builds: `npm run build`

### Documentation

Update documentation when you:
- Add new features
- Change existing functionality
- Add new dependencies
- Change configuration options

### Questions?

- Open an issue for discussion
- Join our Discord (coming soon)
- Email: support@cardcast.app

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive criticism
- Help others learn

## License

By contributing, you agree that your contributions will be licensed under GPL-3.0.

Thank you for helping make CardCast better for the TCG streaming community!